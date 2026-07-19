import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import axios from 'axios';
import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';

// =====================================================
// update_db_ai_clean_prompt_fixed.js
//
// Purpose:
//   Worker that enriches AliBee products with Google AI Studio / Gemini,
//   validates the JSON output, saves multilingual content and insights,
//   and keeps polling the DB for new products.
//
// Security note:
//   Secrets are NOT hard-coded here anymore.
//   Put them in environment variables or run with Node 22+:
//   node --env-file=.env update_db_ai_clean_prompt_fixed.js
//
// Required env variables:
//   GEMINI_API_KEY
//   DB_HOST
//   DB_USER
//   DB_PASSWORD
//   DB_NAME
// =====================================================

// =====================================================
// 1) EDIT SETTINGS HERE
// =====================================================

function envString(name, defaultValue = '') {
  return process.env[name] !== undefined ? String(process.env[name]) : defaultValue;
}

function envNumber(name, defaultValue) {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }

  const numberValue = Number(rawValue);

  if (!Number.isFinite(numberValue)) {
    throw new Error('Invalid numeric environment variable: ' + name + '=' + rawValue);
  }

  return numberValue;
}

function envBool(name, defaultValue) {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }

  const normalized = String(rawValue).trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;

  throw new Error('Invalid boolean environment variable: ' + name + '=' + rawValue);
}

const SETTINGS = {
  // Google / Gemini
  GEMINI_API_KEY: envString('GEMINI_API_KEY'),
  GOOGLE_MODEL: envString('GOOGLE_MODEL', 'gemini-2.5-flash'),
  // Thinking config
  USE_THINKING: envBool('USE_THINKING', false),
  THINKING_LEVEL: envString('THINKING_LEVEL', ThinkingLevel.HIGH),

  // Generation config
  TEMPERATURE: envNumber('TEMPERATURE', 0.9),
  TOP_P: envNumber('TOP_P', 0.95),
  MAX_OUTPUT_TOKENS: envNumber('MAX_OUTPUT_TOKENS', 5000),
  RESPONSE_MIME_TYPE: envString('RESPONSE_MIME_TYPE', 'application/json'),

  // Google Search grounding - keep false for product DB tests
  USE_GOOGLE_SEARCH: envBool('USE_GOOGLE_SEARCH', false),

  // MySQL DB
  DB_HOST: envString('DB_HOST'),
  DB_USER: envString('DB_USER'),
  DB_PASSWORD: envString('DB_PASSWORD'),
  DB_NAME: envString('DB_NAME'),

  // Local prompt files
  SYSTEM_PROMPT_FILE: envString('SYSTEM_PROMPT_FILE', 'prompts/system_prompt.txt'),
  COLUMN_GUIDE_FILE: envString('COLUMN_GUIDE_FILE', 'prompts/column_guide.txt'),

  // Images
  IMAGE_LIMIT: envNumber('IMAGE_LIMIT', 6), // משיכת כל גלריית התמונות הזמינה של המוצר

  // Output
  OUTPUT_DIR: envString('OUTPUT_DIR', 'outputs'),
  SAVE_JSON_OUTPUT_FILE: envBool('SAVE_JSON_OUTPUT_FILE', true),
  // Token counting
  // countTokens is useful for debugging, but it is also an extra API call.
  // Keep false during batch runs to avoid hitting RPM limits twice as fast.
  COUNT_TOKENS_BEFORE_REQUEST: envBool('COUNT_TOKENS_BEFORE_REQUEST', false),

  // Batch & Worker processing
  DB_POLL_INTERVAL_SEC: envNumber('DB_POLL_INTERVAL_SEC', 10), // <--- עודכן לשניות: דגימת ה-DB כל 10 שניות
  BATCH_LIMIT: envNumber('BATCH_LIMIT', 20),
  // 0 = unlimited worker mode; any positive number stops after that many successful products.
  MAX_PRODUCTS_PER_RUN: envNumber('MAX_PRODUCTS_PER_RUN', 0),
  DELAY_BETWEEN_PRODUCTS_MS: envNumber('DELAY_BETWEEN_PRODUCTS_MS', 15000),
  RATE_LIMIT_WAIT_MS: envNumber('RATE_LIMIT_WAIT_MS', 20000),
  RATE_LIMIT_BACKOFF_MULTIPLIER: envNumber('RATE_LIMIT_BACKOFF_MULTIPLIER', 1),
  MAX_RATE_LIMIT_WAIT_MS: envNumber('MAX_RATE_LIMIT_WAIT_MS', 60000),
  MAX_API_RETRIES: envNumber('MAX_API_RETRIES', 5),

  // Debug
  // true = create one JSONL analysis file for the entire run.
  // The file contains product inputs, raw Gemini responses, validation errors,
  // parsed JSON used for DB writes, token usage and processing errors.
  DEBUG_MODE: envBool('DEBUG_MODE', false),
  PRINT_RAW_RESPONSE: envBool('PRINT_RAW_RESPONSE', true),
  SAVE_PROMPT_COPY: envBool('SAVE_PROMPT_COPY', true)
};

const NL = String.fromCharCode(10);
const REQUIRED_HASHTAG_COUNT = 10;
const DEBUG_DIRECTORY_NAME = 'debug_logs';
let debugRunFilePath = null;
const jsonRepairStats = {
  detected: 0,
  parsed_successfully: 0,
  validation_passed: 0,
  saved_to_db: 0,
  rejected: 0
};

function createFileSafeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function initializeDebugRunFile() {
  if (!SETTINGS.DEBUG_MODE) return null;

  const debugDirectory = path.join(process.cwd(), DEBUG_DIRECTORY_NAME);
  await fs.mkdir(debugDirectory, { recursive: true });

  debugRunFilePath = path.join(
    debugDirectory,
    'AI_DEBUG_RUN_' + createFileSafeTimestamp() + '.jsonl'
  );

  const runStartRecord = {
    record_type: 'run_start',
    timestamp: new Date().toISOString(),
    model: SETTINGS.GOOGLE_MODEL,
    image_limit: SETTINGS.IMAGE_LIMIT,
    batch_limit: SETTINGS.BATCH_LIMIT,
    max_products_per_run: SETTINGS.MAX_PRODUCTS_PER_RUN,
    max_output_tokens: SETTINGS.MAX_OUTPUT_TOKENS,
    temperature: SETTINGS.TEMPERATURE,
    top_p: SETTINGS.TOP_P
  };

  await fs.writeFile(
    debugRunFilePath,
    JSON.stringify(runStartRecord) + NL,
    'utf8'
  );

  console.log('DEBUG MODE enabled. Analysis file: ' + debugRunFilePath);
  return debugRunFilePath;
}

async function appendDebugRecord(record) {
  if (!SETTINGS.DEBUG_MODE || !debugRunFilePath) return;

  const safeRecord = {
    timestamp: new Date().toISOString(),
    ...record
  };

  try {
    await fs.appendFile(
      debugRunFilePath,
      JSON.stringify(safeRecord) + NL,
      'utf8'
    );
  } catch (error) {
    console.warn('Could not append to DEBUG analysis file: ' + (error.message || error));
  }
}

function buildDebugProductInput(product, imageUrls) {
  return {
    product_id: String(product.product_id || ''),
    product_title: product.product_title || '',
    product_description_text: htmlToCleanText(product.product_description),
    first_level_category_name: product.first_level_category_name || null,
    second_level_category_name: product.second_level_category_name || null,
    orders: product.orders ?? null,
    image_urls: imageUrls || []
  };
}

// =====================================================
// 2) Helpers
// =====================================================

function validateSettings() {
  const required = [
    'GEMINI_API_KEY',
    'DB_HOST',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME'
  ];

  for (const key of required) {
    const value = SETTINGS[key];
    if (!value || String(value).includes('PASTE_') || String(value).includes('your_') || String(value).includes('xxxx')) {
      throw new Error('Missing required setting: ' + key + '. Set it as an environment variable or in your hosting secret manager.');
    }
  }
}

function normalizeImageUrl(url) {
  if (!url) return '';

  let clean = String(url).trim();
  if (!clean) return '';

  if (clean.startsWith('//')) {
    clean = 'https:' + clean;
  }

  return clean;
}

function getFirstImages(productSmallImageUrls, limit = SETTINGS.IMAGE_LIMIT) {
  if (!productSmallImageUrls || limit <= 0) return [];

  return String(productSmallImageUrls)
    .split(',')
    .map(normalizeImageUrl)
    .filter(Boolean)
    .slice(0, limit);
}

function decodeHtmlEntities(text) {
  if (!text) return '';

  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlToCleanText(html) {
  if (!html) return '';

  let text = String(html);

  text = text.replace(new RegExp('<script[\\s\\S]*?<\\/script>', 'gi'), ' ');
  text = text.replace(new RegExp('<style[\\s\\S]*?<\\/style>', 'gi'), ' ');
  text = text.replace(new RegExp('<img[^>]*>', 'gi'), ' [image] ');
  text = text.replace(new RegExp('<\\/?(div|p|br|li|tr|table|thead|tbody|section|h1|h2|h3|h4|h5|h6)[^>]*>', 'gi'), NL);
  text = text.replace(new RegExp('<[^>]+>', 'g'), ' ');
  text = decodeHtmlEntities(text);

  text = text
    .split(NL)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(NL);

  text = text.replace(new RegExp('(\\[image\\]\\s*){3,}', 'gi'), '[multiple product images]');

  return text.trim();
}

function extractImageUrlsFromHtml(html) {
  if (!html) return [];

  const urls = [];
  const regex = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;

  while ((match = regex.exec(String(html))) !== null) {
    const url = normalizeImageUrl(match[1]);
    if (url) urls.push(url);
  }

  return [...new Set(urls)];
}

async function fetchImageAsBase64(imageUrl) {
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 25000,
      maxContentLength: 12 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });

    const mimeType = response.headers['content-type'] || 'image/jpeg';
    const base64 = Buffer.from(response.data, 'binary').toString('base64');

    return {
      imageUrl,
      mimeType,
      base64,
      base64Length: base64.length
    };
  } catch (error) {
    console.error('Image fetch failed: ' + imageUrl);
    console.error(error.message);
    return null;
  }
}

async function readTextFileRequired(filePath, label) {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  const fileContent = await fs.readFile(resolvedPath, 'utf8');

  if (!fileContent || !fileContent.trim()) {
    throw new Error(label + ' file is empty: ' + resolvedPath);
  }

  console.log('Loaded ' + label + ': ' + resolvedPath);
  return fileContent.trim();
}

function extractJsonFromText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();

  if (!raw) {
    throw new Error('Gemini response is empty');
  }

  const withoutMarkdown = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const firstBrace = withoutMarkdown.indexOf('{');

  if (firstBrace === -1) {
    throw new Error('No JSON object found in Gemini response');
  }

  const prefix = withoutMarkdown.slice(0, firstBrace).trim();

  if (prefix) {
    throw new Error('Unexpected text was found before the JSON object');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let rootEndIndex = -1;

  for (let index = firstBrace; index < withoutMarkdown.length; index += 1) {
    const char = withoutMarkdown[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        rootEndIndex = index;
        break;
      }

      if (depth < 0) {
        throw new Error('JSON contains an unexpected closing brace');
      }
    }
  }

  if (rootEndIndex === -1 || depth !== 0 || inString) {
    throw new Error('Gemini JSON appears incomplete or was cut off before the root object closed');
  }

  const jsonCandidate = withoutMarkdown.slice(firstBrace, rootEndIndex + 1);
  const trailingText = withoutMarkdown.slice(rootEndIndex + 1).trim();
  const repair = {
    applied: false,
    repair_type: null,
    removed_text: '',
    removed_character_count: 0,
    parse_succeeded: false,
    validation_passed: false,
    db_saved: false
  };

  if (trailingText) {
    if (!/^}+$/.test(trailingText)) {
      throw new Error('Unexpected non-whitespace content was found after the complete JSON object');
    }

    repair.applied = true;
    repair.repair_type = 'removed_trailing_extra_closing_braces';
    repair.removed_text = trailingText;
    repair.removed_character_count = trailingText.length;
  }

  try {
    const parsedJson = JSON.parse(jsonCandidate);
    repair.parse_succeeded = true;

    return {
      parsedJson,
      repair,
      jsonCandidate
    };
  } catch (error) {
    const parseError = new Error('JSON parse failed: ' + error.message);
    parseError.jsonRepair = repair;
    throw parseError;
  }
}

function validateProductIdMatchesRequest(aiResult, expectedProductId) {
  const returnedProductId = String(aiResult?.product_id ?? '').trim();
  const expected = String(expectedProductId ?? '').trim();

  if (!returnedProductId || returnedProductId !== expected) {
    throw new Error(
      'Gemini product_id does not match the requested product. Expected: ' +
      expected + ', received: ' + (returnedProductId || '[missing]')
    );
  }
}

function buildTextOutput(aiResult) {
  const lines = [];

  lines.push('=========================================');
  lines.push('GOOGLE GEMINI PRODUCT OUTPUT');
  lines.push('=========================================');
  lines.push('Product ID: ' + (aiResult.product_id || '')); 
  lines.push('');

  lines.push('English');
  lines.push('Name: ' + (aiResult.english?.name || ''));
  lines.push('Description: ' + (aiResult.english?.description || ''));
  lines.push('Hashtags: ' + (aiResult.english?.hashtags || []).join(' '));
  lines.push('');

  lines.push('Hebrew');
  lines.push('שם: ' + (aiResult.hebrew?.name || ''));
  lines.push('תיאור: ' + (aiResult.hebrew?.description || ''));
  lines.push('האשטגים: ' + (aiResult.hebrew?.hashtags || []).join(' '));
  lines.push('');

  lines.push('Arabic');
  lines.push('Name: ' + (aiResult.arabic?.name || ''));
  lines.push('Description: ' + (aiResult.arabic?.description || ''));
  lines.push('Hashtags: ' + (aiResult.arabic?.hashtags || []).join(' '));
  lines.push('');

  lines.push('French');
  lines.push('Name: ' + (aiResult.french?.name || ''));
  lines.push('Description: ' + (aiResult.french?.description || ''));
  lines.push('Hashtags: ' + (aiResult.french?.hashtags || []).join(' '));
  lines.push('');

  lines.push('Spanish');
  lines.push('Name: ' + (aiResult.spanish?.name || ''));
  lines.push('Description: ' + (aiResult.spanish?.description || ''));
  lines.push('Hashtags: ' + (aiResult.spanish?.hashtags || []).join(' '));
  lines.push('');

  lines.push('Russian');
  lines.push('Name: ' + (aiResult.russian?.name || ''));
  lines.push('Description: ' + (aiResult.russian?.description || ''));
  lines.push('Hashtags: ' + (aiResult.russian?.hashtags || []).join(' '));
  lines.push('');

  lines.push('Meta');
  lines.push('Detected product type: ' + (aiResult.detected_product_type || '')); 
  lines.push('First category ID: ' + (aiResult.first_category_id || '')); 
  lines.push('First category name: ' + (aiResult.first_category_name || '')); 
  lines.push('Second category ID: ' + (aiResult.second_category_id || '')); 
  lines.push('Second category name: ' + (aiResult.second_category_name || '')); 
  lines.push('Third category ID: ' + (aiResult.third_category_id || '')); 
  lines.push('Third category name: ' + (aiResult.third_category_name || '')); 
  lines.push('Category path: ' + (aiResult.category_path || '')); 
  lines.push('Category confidence: ' + (aiResult.category_confidence ?? '')); 
  lines.push('Category reason: ' + (aiResult.category_reason || '')); 
  lines.push('Confidence: ' + aiResult.confidence); 
  lines.push('Image score: ' + aiResult.image_score); 
  lines.push('Content sensitivity level: ' + aiResult.content_sensitivity_level); 
  lines.push('Audience gender code: ' + aiResult.audience_gender_code); 
  lines.push('Is giftable: ' + aiResult.is_giftable); 
  lines.push('Product insights: ' + (aiResult.product_insights ? 'present' : 'missing')); 
  lines.push('Notes: ' + (aiResult.notes || '')); 
  lines.push('=========================================');

  return lines.join(NL);
}

// =====================================================
// 3) DB
// =====================================================

async function createDbConnection() {
  return mysql.createConnection({
    host: SETTINGS.DB_HOST,
    user: SETTINGS.DB_USER,
    password: SETTINGS.DB_PASSWORD,
    database: SETTINGS.DB_NAME,
    charset: 'utf8mb4'
  });
}

async function getProductFromDb(productId) {
  const connection = await createDbConnection();

  try {
    const [rows] = await connection.execute(
      `
      SELECT 
        a.product_id,
        a.product_title,
        a.product_description,
        a.first_level_category_name,
        a.second_level_category_name,
        a.orders,
        a.product_small_image_urls
      FROM alibee_products AS a
      WHERE a.product_id = ?
      LIMIT 1
      `,
      [productId]
    );

    return rows[0] || null;
  } finally {
    await connection.end();
  }
}

async function getUnprocessedProductsFromDb(limit) {
  const connection = await createDbConnection();
  const safeLimit = Math.max(1, Number(limit || SETTINGS.BATCH_LIMIT));

  try {
    const [rows] = await connection.execute(
      `
      SELECT
        a.product_id,
        a.product_title,
        a.product_description,
        a.first_level_category_name,
        a.second_level_category_name,
        a.orders,
        a.product_small_image_urls
      FROM alibee_products AS a
      WHERE a.ai_processed_at IS NULL
        AND (a.ai_failed IS NULL OR a.ai_failed = 0)
      ORDER BY a.product_id
      LIMIT ${safeLimit}
      `
    );

    return rows;
  } finally {
    await connection.end();
  }
}

async function markProductAiProcessed(productId) {
  const connection = await createDbConnection();

  try {
    await connection.execute(
      `
      UPDATE alibee_products
      SET
        ai_processed_at = NOW(),
        updated_at = NOW()
      WHERE product_id = ?
      `,
      [productId]
    );
  } finally {
    await connection.end();
  }
}

async function markProductProhibitedContent(productId) {
  const connection = await createDbConnection();

  try {
    await connection.execute(
      `
      UPDATE alibee_products
      SET
        ai_failed = 1,
        updated_at = NOW()
      WHERE product_id = ?
      `,
      [productId]
    );
  } finally {
    await connection.end();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  const status = error?.status || error?.code || error?.response?.status;
  const message = String(error?.message || error || '').toLowerCase();

  return (
    status === 429 ||
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('quota') ||
    message.includes('resource exhausted') ||
    message.includes('too many requests') ||
    message.includes('exceeded')
  );
}

function simplifyErrorForLog(error) {
  if (!error) return { error: 'Unknown error' };

  const simplified = {
    name: error.name,
    message: error.message,
    status: error.status,
    code: error.code,
    responseStatus: error.response?.status,
    responseStatusText: error.response?.statusText,
    responseData: error.response?.data,
    details: error.details,
    cause: error.cause?.message || error.cause
  };

  return Object.fromEntries(
    Object.entries(simplified).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

function logShortError(label, error) {
  const quotaInfo = extractGeminiQuotaInfo(error);

  console.error(label);
  console.error('Error: ' + (quotaInfo.message || error?.message || error));

  if (quotaInfo.quotaMetric || quotaInfo.quotaId) {
    console.error('Quota: ' + (quotaInfo.quotaMetric || 'unknown'));
    console.error('Quota ID: ' + (quotaInfo.quotaId || 'unknown'));
    console.error('Limit: ' + (quotaInfo.quotaValue || 'unknown'));
  }

  if (quotaInfo.retryDelaySeconds) {
    console.error('Suggested retry: ' + quotaInfo.retryDelaySeconds + ' seconds');
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function extractGeminiQuotaInfo(error) {
  const rawMessage = String(error?.message || '');
  const outer = safeJsonParse(rawMessage);

  let inner = null;

  if (outer?.error?.message) {
    inner = safeJsonParse(outer.error.message);
  }

  const errorBody = inner?.error || outer?.error || null;
  const details = Array.isArray(errorBody?.details) ? errorBody.details : [];

  const quotaFailure = details.find(item => String(item['@type'] || '').includes('QuotaFailure'));
  const retryInfo = details.find(item => String(item['@type'] || '').includes('RetryInfo'));
  const violation = quotaFailure?.violations?.[0] || null;

  const retryDelayText = retryInfo?.retryDelay || '';
  const retryDelaySeconds = retryDelayText.endsWith('s')
    ? Number(retryDelayText.replace('s', ''))
    : null;

  const quotaId = violation?.quotaId || '';
  const quotaMetric = violation?.quotaMetric || '';
  const quotaValue = violation?.quotaValue || '';
  const model = violation?.quotaDimensions?.model || '';

  return {
    status: errorBody?.status || outer?.error?.status || '',
    code: errorBody?.code || outer?.error?.code || error?.status || '',
    message: errorBody?.message || outer?.error?.message || rawMessage,
    quotaMetric,
    quotaId,
    quotaValue,
    model,
    retryDelaySeconds,
    isFreeTierGenerateRequests: quotaMetric.includes('generate_content_free_tier_requests'),
    isDailyQuota: quotaId.toLowerCase().includes('perday') || quotaId.toLowerCase().includes('per_day')
  };
}

async function countGeminiInputTokens(ai, model, contents) {
  try {
    const tokenCount = await ai.models.countTokens({
      model,
      contents
    });

    return tokenCount?.totalTokens ?? null;
  } catch (error) {
    console.warn('Could not count input tokens before request: ' + (error.message || error));
    return null;
  }
}

function logTokenUsage(productId, inputTokenEstimate, usageMetadata, images) {
  const imageCount = images.length;
  const totalBase64Chars = images.reduce((sum, img) => sum + Number(img.base64Length || 0), 0);
  const estimatedImageMb = totalBase64Chars / 1024 / 1024;

  console.log('');
  console.log('TOKEN / REQUEST USAGE');
  console.log('Product ID: ' + productId);
  console.log('Images sent: ' + imageCount);
  console.log('Images Base64 size: ' + estimatedImageMb.toFixed(2) + ' MB');

  if (inputTokenEstimate !== null && inputTokenEstimate !== undefined) {
    console.log('Input tokens estimate before request: ' + inputTokenEstimate);
  } else {
    console.log('Input tokens estimate before request: unavailable');
  }

  if (usageMetadata) {
    console.log('Prompt tokens actual: ' + (usageMetadata.promptTokenCount ?? 'unavailable'));
    console.log('Output tokens actual: ' + (usageMetadata.candidatesTokenCount ?? 'unavailable'));
    console.log('Total tokens actual: ' + (usageMetadata.totalTokenCount ?? 'unavailable'));
  } else {
    console.log('Usage metadata after response: unavailable');
  }

  console.log('');
}

async function getAlibeeThreeLevelCategoryOptionsFromDb() {
  const connection = await createDbConnection();

  try {
    const [rows] = await connection.execute(
      `
      SELECT
        c1.id AS first_category_id,
        c1.name_en AS first_category_name,
        c2.id AS second_category_id,
        c2.name_en AS second_category_name,
        c3.id AS third_category_id,
        c3.name_en AS third_category_name
      FROM alibee_categories AS c1
      JOIN alibee_categories AS c2
        ON c2.parent_id = c1.id
      JOIN alibee_categories AS c3
        ON c3.parent_id = c2.id
      WHERE c1.level = 1
        AND c2.level = 2
        AND c3.level = 3
        AND c1.is_active = 1
        AND c2.is_active = 1
        AND c3.is_active = 1
      ORDER BY c1.sort_order, c2.sort_order, c3.sort_order, c1.id, c2.id, c3.id
      `
    );

    if (!rows.length) {
      throw new Error('No active three-level categories found in alibee_categories');
    }

    return rows
      .map(row =>
        String(row.first_category_id) + ' / ' + String(row.second_category_id) + ' / ' + String(row.third_category_id) + ' = ' + row.first_category_name + ' > ' + row.second_category_name + ' > ' + row.third_category_name
      )
      .join(NL);
  } finally {
    await connection.end();
  }
}

async function getLanguageIdMapFromDb() {
  const connection = await createDbConnection();

  try {
    const [rows] = await connection.execute(
      `
      SELECT id, language_code
      FROM alibee_languages
      WHERE is_active = 1
      `
    );

    const languageMap = {};

    for (const row of rows) {
      languageMap[String(row.language_code).toLowerCase()] = row.id;
    }

    return languageMap;
  } finally {
    await connection.end();
  }
}

function normalizeHashtagArray(hashtags) {
  if (!hashtags) return [];

  if (Array.isArray(hashtags)) {
    return hashtags
      .map(tag => String(tag || '').trim())
      .filter(Boolean);
  }

  return String(hashtags)
    .split(/\s+/)
    .map(tag => String(tag || '').trim())
    .filter(Boolean);
}

function normalizeHashtagsForDb(hashtags) {
  return normalizeHashtagArray(hashtags).join(' ');
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;

  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) return null;

  return Math.trunc(numberValue);
}

function toNullableString(value) {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();

  return text || null;
}

function buildCategoryPathFromAiResult(aiResult) {
  const explicitPath = toNullableString(aiResult.category_path);

  if (explicitPath) return explicitPath;

  const pathParts = [
    toNullableString(aiResult.first_category_name),
    toNullableString(aiResult.second_category_name),
    toNullableString(aiResult.third_category_name)
  ].filter(Boolean);

  return pathParts.length ? pathParts.join(' > ') : null;
}

function normalizeCategoryPathText(value) {
  return String(value || '')
    .replace(/\s*>\s*/g, ' > ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAlibeeCategoryOptions(alibeeCategoryOptions) {
  const byIdPath = new Map();
  const byNamePath = new Map();

  const lines = String(alibeeCategoryOptions || '')
    .split(NL)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*=\s*(.+?)\s*>\s*(.+?)\s*>\s*(.+)$/);

    if (!match) {
      continue;
    }

    const item = {
      firstId: Number(match[1]),
      secondId: Number(match[2]),
      thirdId: Number(match[3]),
      firstName: match[4].trim(),
      secondName: match[5].trim(),
      thirdName: match[6].trim()
    };

    item.idPath = item.firstId + '/' + item.secondId + '/' + item.thirdId;
    item.namePath = item.firstName + ' > ' + item.secondName + ' > ' + item.thirdName;

    byIdPath.set(item.idPath, item);
    byNamePath.set(normalizeCategoryPathText(item.namePath), item);
  }

  return { byIdPath, byNamePath };
}

function validateAiCategorySelection(aiResult, alibeeCategoryOptions) {
  const parsedOptions = parseAlibeeCategoryOptions(alibeeCategoryOptions);

  if (!parsedOptions.byIdPath.size) {
    throw new Error('Could not parse Alibee category options for validation.');
  }

  const firstId = toNullableInt(aiResult.first_category_id);
  const secondId = toNullableInt(aiResult.second_category_id);
  const thirdId = toNullableInt(aiResult.third_category_id);
  const idPath = firstId + '/' + secondId + '/' + thirdId;

  let selected = parsedOptions.byIdPath.get(idPath);

  if (!selected) {
    selected = parsedOptions.byNamePath.get(normalizeCategoryPathText(aiResult.category_path));
  }

  if (!selected) {
    throw new Error(
      'Gemini returned a category that is not in the allowed Alibee category list. ' +
      'Received IDs: ' + idPath + ', path: ' + String(aiResult.category_path || '')
    );
  }

  // Normalize DB values to the exact allowed category option.
  aiResult.first_category_id = selected.firstId;
  aiResult.first_category_name = selected.firstName;
  aiResult.second_category_id = selected.secondId;
  aiResult.second_category_name = selected.secondName;
  aiResult.third_category_id = selected.thirdId;
  aiResult.third_category_name = selected.thirdName;
  aiResult.category_path = selected.namePath;
}

function findBannedCopyPhrases(aiResult) {
  const languageChecks = [
    {
      label: 'english',
      data: aiResult.english,
      bannedRegexes: [
        / this /i,
        / these /i,
        / that /i,
        / those /i,
        / you /i,
        / your /i
      ]
    },
    {
      label: 'hebrew',
      data: aiResult.hebrew,
      bannedRegexes: [
        / זה /u,
        / זו /u,
        / זאת /u,
        / הזה /u,
        / הזו /u,
        / הזאת /u,
        / אלו /u,
        / אלה /u,
        / הללו /u,
        / שלך /u,
        / שלכם /u,
        / אתכם /u
      ]
    },
    {
      label: 'arabic',
      data: aiResult.arabic,
      bannedRegexes: [
        / هذا /u,
        / هذه /u,
        / هؤلاء /u,
        / ذلك /u,
        / تلك /u,
        / أنت /u,
        / لك /u
      ]
    },
    {
      label: 'french',
      data: aiResult.french,
      bannedRegexes: [
        / ce /i,
        / cet /i,
        / cette /i,
        / ces /i,
        / vous /i,
        / votre /i,
        / vos /i
      ]
    },
    {
      label: 'spanish',
      data: aiResult.spanish,
      bannedRegexes: [
        / este /i,
        / esta /i,
        / estos /i,
        / estas /i,
        / eso /i,
        / esos /i,
        / esas /i,
        / tú /i,
        / tu /i,
        / tus /i
      ]
    },
    {
      label: 'russian',
      data: aiResult.russian,
      bannedRegexes: [
        / этот /i,
        / эта /i,
        / это /i,
        / эти /i,
        / ваш /i,
        / ваша /i,
        / ваши /i,
        / ты /i
      ]
    }
  ];

  const findings = [];

  for (const check of languageChecks) {
    const text = [
      check.data?.name || '',
      check.data?.description || '',
      Array.isArray(check.data?.hashtags) ? check.data.hashtags.join(' ') : String(check.data?.hashtags || ''),
      Array.isArray(check.data?.reviews) ? check.data.reviews.join(' ') : String(check.data?.reviews || '')
    ].join(' ');

    for (const regex of check.bannedRegexes) {
      if (regex.test(text)) {
        findings.push(check.label + ': ' + regex.toString());
      }
    }
  }

  return findings;
}

function validateRequiredAiLanguages(aiResult) {
  const requiredLanguages = [
    { key: 'english', code: 'en' },
    { key: 'hebrew', code: 'he' },
    { key: 'arabic', code: 'ar' },
    { key: 'french', code: 'fr' },
    { key: 'spanish', code: 'es' },
    { key: 'russian', code: 'ru' }
  ];

  const missing = [];

  for (const lang of requiredLanguages) {
    const data = aiResult?.[lang.key];
    const cleanedHashtags = normalizeHashtagArray(data?.hashtags);

    if (
      !data ||
      !data.name ||
      !data.description ||
      cleanedHashtags.length !== REQUIRED_HASHTAG_COUNT ||
      !Array.isArray(data.reviews)
    ) {
      missing.push(lang.key + ' (' + lang.code + ')');
    } else {
      data.hashtags = cleanedHashtags;
    }
  }

  if (missing.length) {
    throw new Error('Gemini returned incomplete language output. Missing or invalid: ' + missing.join(', '));
  }
}

function validateRequiredAiCodes(aiResult) {
  const checks = [
    {
      field: 'content_sensitivity_level',
      allowedValues: [1, 2, 3, 4, 5],
      label: 'content_sensitivity_level must be an integer from 1 to 5'
    },
    {
      field: 'audience_gender_code',
      allowedValues: [1, 2, 3, 4, 5],
      label: 'audience_gender_code must be an integer from 1 to 5'
    },
    {
      field: 'is_giftable',
      allowedValues: [0, 1],
      label: 'is_giftable must be exactly 0 or 1'
    }
  ];

  const invalid = [];

  for (const check of checks) {
    const rawValue = aiResult?.[check.field];
    const intValue = toNullableInt(rawValue);

    if (intValue === null || !check.allowedValues.includes(intValue)) {
      invalid.push(check.label + '. Received: ' + String(rawValue));
    } else {
      aiResult[check.field] = intValue;
    }
  }

  if (invalid.length) {
    throw new Error('Gemini returned missing or invalid mandatory AI code field(s): ' + invalid.join(' | '));
  }
}

function validateRequiredAiNumericScores(aiResult) {
  const invalid = [];

  const imageScore = toNullableInt(aiResult?.image_score);
  if (imageScore === null || imageScore < 1 || imageScore > 10) {
    invalid.push('image_score must be an integer from 1 to 10. Received: ' + String(aiResult?.image_score));
  } else {
    aiResult.image_score = imageScore;
  }

  const categoryConfidence = toNullableInt(aiResult?.category_confidence);
  if (categoryConfidence === null || categoryConfidence < 0 || categoryConfidence > 100) {
    invalid.push('category_confidence must be an integer from 0 to 100. Received: ' + String(aiResult?.category_confidence));
  } else {
    aiResult.category_confidence = categoryConfidence;
  }

  const confidence = Number(aiResult?.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    invalid.push('confidence must be a number from 0 to 1. Received: ' + String(aiResult?.confidence));
  } else {
    aiResult.confidence = confidence;
  }

  if (invalid.length) {
    throw new Error('Gemini returned missing or invalid numeric score field(s): ' + invalid.join(' | '));
  }
}


function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRequiredInsightsString(insightsObject, keyPath, key) {
  const value = insightsObject?.[key];

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('product_insights.' + keyPath + ' must be a non-empty English string. Received: ' + String(value));
  }

  insightsObject[key] = value.trim();
}

function validateRequiredInsightsStringArray(insightsObject, keyPath, key) {
  const value = insightsObject?.[key];

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('product_insights.' + keyPath + ' must be a non-empty array of English strings.');
  }

  const cleaned = value
    .map(item => String(item || '').trim())
    .filter(Boolean);

  if (!cleaned.length) {
    throw new Error('product_insights.' + keyPath + ' must contain at least one non-empty English string.');
  }

  insightsObject[key] = cleaned;
}

function validateProductInsights(aiResult) {
  const insights = aiResult?.product_insights;

  if (!isPlainObject(insights)) {
    throw new Error('Gemini returned missing or invalid mandatory product_insights object.');
  }

  const requiredObjects = [
    'target_audience',
    'purchase_intent',
    'marketing_angles',
    'product_attributes'
  ];

  for (const key of requiredObjects) {
    if (!isPlainObject(insights[key])) {
      throw new Error('Gemini returned missing or invalid product_insights.' + key + ' object.');
    }
  }

  validateRequiredInsightsString(insights.target_audience, 'target_audience.primary', 'primary');
  validateRequiredInsightsString(insights.target_audience, 'target_audience.secondary', 'secondary');
  validateRequiredInsightsString(insights.target_audience, 'target_audience.age_vibe', 'age_vibe');
  validateRequiredInsightsStringArray(insights.target_audience, 'target_audience.style_vibe', 'style_vibe');

  validateRequiredInsightsString(insights.purchase_intent, 'purchase_intent.main_reason', 'main_reason');
  validateRequiredInsightsStringArray(insights.purchase_intent, 'purchase_intent.use_cases', 'use_cases');
  validateRequiredInsightsString(insights.purchase_intent, 'purchase_intent.problem_solved', 'problem_solved');

  validateRequiredInsightsString(insights.marketing_angles, 'marketing_angles.main_hook', 'main_hook');
  validateRequiredInsightsStringArray(insights.marketing_angles, 'marketing_angles.short_hooks', 'short_hooks');

  validateRequiredInsightsString(insights.product_attributes, 'product_attributes.material_guess', 'material_guess');
  validateRequiredInsightsString(insights.product_attributes, 'product_attributes.color_family', 'color_family');
  validateRequiredInsightsString(insights.product_attributes, 'product_attributes.pattern', 'pattern');
  validateRequiredInsightsString(insights.product_attributes, 'product_attributes.fit', 'fit');
  validateRequiredInsightsStringArray(insights.product_attributes, 'product_attributes.occasion', 'occasion');
  validateRequiredInsightsStringArray(insights.product_attributes, 'product_attributes.season', 'season');
}

async function updateProductCategoriesInProductsDb(productId, aiResult) {
  const connection = await createDbConnection();

  try {
    await connection.execute(
      `
      UPDATE alibee_products
      SET
        product_title = COALESCE(NULLIF(?, ''), product_title),
        is_active = 1,
        first_level_category_id = ?,
        first_level_category_name = ?,
        second_level_category_id = ?,
        second_level_category_name = ?,
        third_level_category_id = ?,
        third_level_category_name = ?,
        category_path = ?,
        content_sensitivity_level = ?,
        audience_gender_code = ?,
        is_giftable = ?,
        updated_at = NOW()
      WHERE product_id = ?
      `,
      [
        toNullableString(aiResult.english?.name),
        toNullableInt(aiResult.first_category_id),
        toNullableString(aiResult.first_category_name),
        toNullableInt(aiResult.second_category_id),
        toNullableString(aiResult.second_category_name),
        toNullableInt(aiResult.third_category_id),
        toNullableString(aiResult.third_category_name),
        buildCategoryPathFromAiResult(aiResult),
        toNullableInt(aiResult.content_sensitivity_level),
        toNullableInt(aiResult.audience_gender_code),
        toNullableInt(aiResult.is_giftable),
        productId
      ]
    );
  } finally {
    await connection.end();
  }
}


async function saveProductInsightsToDb(productId, aiResult) {
  const insights = aiResult.product_insights;
  const englishHashtags = normalizeHashtagArray(aiResult.english?.hashtags);
  const rawInsightsJson = {
    ...insights,
    english_hashtags: englishHashtags
  };

  const connection = await createDbConnection();

  try {
    const sql = `
      INSERT INTO alibee_product_ai_insights
        (
          product_id,
          target_audience,
          purchase_intent,
          marketing_angles,
          product_attributes,
          english_hashtags,
          raw_insights_json,
          model_name,
          insights_version
        )
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        target_audience = VALUES(target_audience),
        purchase_intent = VALUES(purchase_intent),
        marketing_angles = VALUES(marketing_angles),
        product_attributes = VALUES(product_attributes),
        english_hashtags = VALUES(english_hashtags),
        raw_insights_json = VALUES(raw_insights_json),
        model_name = VALUES(model_name),
        insights_version = VALUES(insights_version),
        updated_at = NOW()
    `;

    await connection.execute(sql, [
      productId,
      JSON.stringify(insights.target_audience),
      JSON.stringify(insights.purchase_intent),
      JSON.stringify(insights.marketing_angles),
      JSON.stringify(insights.product_attributes),
      JSON.stringify(englishHashtags),
      JSON.stringify(rawInsightsJson),
      SETTINGS.GOOGLE_MODEL,
      1
    ]);
  } finally {
    await connection.end();
  }
}

async function saveAiContentToDb(productId, aiResult) {
  const languageMap = await getLanguageIdMapFromDb();

  const languageObjects = [
    { code: 'en', data: aiResult.english },
    { code: 'he', data: aiResult.hebrew },
    { code: 'ar', data: aiResult.arabic },
    { code: 'fr', data: aiResult.french },
    { code: 'es', data: aiResult.spanish },
    { code: 'ru', data: aiResult.russian }
  ];

  const connection = await createDbConnection();

  try {
    const sql = `
      INSERT INTO alibee_product_ai_content
        (
          product_id,
          language_id,
          product_name,
          product_description,
          hashtags,
          detected_product_type,
          first_category_id,
          first_category_name,
          second_category_id,
          second_category_name,
          third_category_id,
          third_category_name,
          category_path,
          category_confidence,
          category_reason,
          confidence,
          image_score,
          notes,
          model_name,
          raw_json
        )
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        product_name = VALUES(product_name),
        product_description = VALUES(product_description),
        hashtags = VALUES(hashtags),
        detected_product_type = VALUES(detected_product_type),
        first_category_id = VALUES(first_category_id),
        first_category_name = VALUES(first_category_name),
        second_category_id = VALUES(second_category_id),
        second_category_name = VALUES(second_category_name),
        third_category_id = VALUES(third_category_id),
        third_category_name = VALUES(third_category_name),
        category_path = VALUES(category_path),
        category_confidence = VALUES(category_confidence),
        category_reason = VALUES(category_reason),
        confidence = VALUES(confidence),
        image_score = VALUES(image_score),
        notes = VALUES(notes),
        model_name = VALUES(model_name),
        raw_json = VALUES(raw_json)
    `;

    let savedCount = 0;
    const rawJson = JSON.stringify(aiResult);

    for (const item of languageObjects) {
      const languageId = languageMap[item.code];
      const data = item.data;

      if (!languageId) {
        console.warn('Skipping language because it was not found in alibee_languages: ' + item.code);
        continue;
      }

      if (!data || !data.name) {
        console.warn('Skipping language because AI result is missing name: ' + item.code);
        continue;
      }

      await connection.execute(sql, [
        productId,
        languageId,
        data.name || '',
        data.description || '',
        normalizeHashtagsForDb(data.hashtags),
        aiResult.detected_product_type || '',
        aiResult.first_category_id || null,
        aiResult.first_category_name || '',
        aiResult.second_category_id || null,
        aiResult.second_category_name || '',
        aiResult.third_category_id || null,
        aiResult.third_category_name || '',
        aiResult.category_path || '',
        aiResult.category_confidence ?? null,
        aiResult.category_reason || '',
        aiResult.confidence ?? null,
        aiResult.image_score ?? null,
        aiResult.notes || '',
        SETTINGS.GOOGLE_MODEL,
        rawJson
      ]);

      savedCount += 1;
    }

    return savedCount;
  } finally {
    await connection.end();
  }
}

// =====================================================
// 4) Prompt
// =====================================================

function buildUserPrompt(product, columnGuide, alibeeCategoryOptions) {
  const descriptionText = htmlToCleanText(product.product_description);
  const descriptionImageUrls = extractImageUrlsFromHtml(product.product_description);

  const productDataForAi = {
    product_id: product.product_id,
    product_title: product.product_title,
    product_description_text: descriptionText || '[No useful text found in product_description HTML]',
    product_description_image_urls: descriptionImageUrls.slice(0, 30),
    product_description_image_count: descriptionImageUrls.length,
    first_level_category_name: product.first_level_category_name,
    second_level_category_name: product.second_level_category_name,
    orders: product.orders,
    product_small_image_urls: product.product_small_image_urls
  };

  const lines = [];

  lines.push('Analyze this product using the fixed rules from the system instruction.');
  lines.push('Return exactly one valid JSON object that matches the mandatory schema from the system instruction.');
  lines.push('Do not add markdown, explanations, reasoning, or any text outside the JSON.');
  lines.push('');
  lines.push('DB COLUMN GUIDE:');
  lines.push(columnGuide || 'No column guide was provided.');
  lines.push('');
  lines.push('PRODUCT DATA FROM DB:');
  lines.push(JSON.stringify(productDataForAi, null, 2));
  lines.push('');
  lines.push('ALIBEE THREE-LEVEL CATEGORY OPTIONS:');
  lines.push(alibeeCategoryOptions || 'No Alibee category options were provided.');
  lines.push('');
  lines.push('IMPORTANT DYNAMIC CONTEXT:');
  lines.push('- The images attached before this text are product images.');
  lines.push('- The first attached image is the primary product image.');
  lines.push('- Use the category options above to choose exactly one valid three-level Alibee category path.');
  lines.push('- product_insights must be written in English only.');
  lines.push('- content_sensitivity_level, audience_gender_code, is_giftable, and product_insights are mandatory.');
  lines.push('- If a field is uncertain, follow the fallback rules in the system instruction.');
  lines.push('');
  lines.push('Return valid JSON only.');

  return lines.join(NL);
}

function buildGeminiContents(userPrompt, images) {
  const parts = [];

  for (const img of images) {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64
      }
    });
  }

  parts.push({
    text: userPrompt
  });

  return [
    {
      role: 'user',
      parts
    }
  ];
}

function buildGeminiConfig(systemPrompt) {
  const config = {
    systemInstruction: systemPrompt,
    temperature: SETTINGS.TEMPERATURE,
    topP: SETTINGS.TOP_P,
    maxOutputTokens: SETTINGS.MAX_OUTPUT_TOKENS,
    responseMimeType: SETTINGS.RESPONSE_MIME_TYPE
  };

  if (SETTINGS.USE_THINKING) {
    config.thinkingConfig = {
      thinkingLevel: SETTINGS.THINKING_LEVEL
    };
  }

  if (SETTINGS.USE_GOOGLE_SEARCH) {
    config.tools = [
      {
        googleSearch: {}
      }
    ];
  }

  return config;
}

// =====================================================
// 5) Save JSON result only
// =====================================================

async function saveJsonResultFile(productId, parsedJson) {
  await fs.mkdir(SETTINGS.OUTPUT_DIR, { recursive: true });

  if (!parsedJson) {
    throw new Error('Cannot save JSON result because Gemini response was not valid JSON.');
  }

  const safeProductId = String(productId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const jsonPath = path.join(SETTINGS.OUTPUT_DIR, 'GOOGLE_RESULT_' + safeProductId + '.json');

  await fs.writeFile(jsonPath, JSON.stringify(parsedJson, null, 2), 'utf8');

  return jsonPath;
}

// =====================================================
// 6) Product processing
// =====================================================

async function processProduct(product, ai, systemPrompt, columnGuide, alibeeCategoryOptions) {
  const productId = product.product_id;

  console.log('-----------------------------------------');
  console.log('Processing product_id: ' + productId);
  console.log('Product found: ' + product.product_title);

  const userPrompt = buildUserPrompt(product, columnGuide, alibeeCategoryOptions);

  const imageUrls = getFirstImages(product.product_small_image_urls, SETTINGS.IMAGE_LIMIT);
  const debugProductInput = buildDebugProductInput(product, imageUrls);
  console.log('Found ' + imageUrls.length + ' image URL(s). Downloading...');

  const images = [];

  for (const imageUrl of imageUrls) {
    const imageData = await fetchImageAsBase64(imageUrl);
    if (imageData) {
      images.push(imageData);
    }
  }

  console.log('Loaded ' + images.length + ' image(s) as Base64.');

  if (imageUrls.length > 0 && images.length !== imageUrls.length) {
    console.warn('Skipping product_id ' + productId + ' for this run because one or more product images failed to download.');
    console.warn('ai_processed_at was NOT updated, so this product can be retried later.');
    await appendDebugRecord({
      record_type: 'product_result',
      status: 'temporary_image_download_failure',
      product: debugProductInput,
      requested_image_count: imageUrls.length,
      loaded_image_count: images.length,
      ai_processed_at_updated: false,
      ai_failed_value: 0
    });
    return 'temporary_skip';
  }

  if (images.length === 0) {
    console.warn('Skipping product_id ' + productId + ' for this run because no product images were downloaded.');
    console.warn('ai_processed_at was NOT updated, so this product can be retried later.');
    await appendDebugRecord({
      record_type: 'product_result',
      status: 'no_images_downloaded',
      product: debugProductInput,
      requested_image_count: imageUrls.length,
      loaded_image_count: 0,
      ai_processed_at_updated: false,
      ai_failed_value: 0
    });
    return 'temporary_skip';
  }

  const config = buildGeminiConfig(systemPrompt);
  const contents = buildGeminiContents(userPrompt, images);

  let inputTokenEstimate = null;

  if (SETTINGS.COUNT_TOKENS_BEFORE_REQUEST) {
    inputTokenEstimate = await countGeminiInputTokens(ai, SETTINGS.GOOGLE_MODEL, contents);
    if (inputTokenEstimate !== null && inputTokenEstimate !== undefined) {
      console.log('Input tokens estimate before request: ' + inputTokenEstimate);
    }
  } else {
    console.log('Input token estimate before request: skipped to reduce RPM usage.');
  }

  console.log('Sending request to Gemini...');

  const response = await ai.models.generateContentStream({
    model: SETTINGS.GOOGLE_MODEL,
    config,
    contents
  });

  let fullText = '';
  let usageMetadata = null;
  let promptFeedback = null;

  for await (const chunk of response) {
    if (chunk.text) {
      fullText += chunk.text;
      process.stdout.write(chunk.text);
    }

    if (chunk.usageMetadata) {
      usageMetadata = chunk.usageMetadata;
    }

    if (chunk.promptFeedback) {
      promptFeedback = chunk.promptFeedback;
    }
  }

  console.log();
  console.log();

  logTokenUsage(productId, inputTokenEstimate, usageMetadata, images);

  const blockReason = String(promptFeedback?.blockReason || '').trim().toUpperCase();

  if (blockReason === 'PROHIBITED_CONTENT') {
    console.error('PROHIBITED_CONTENT: Gemini blocked product_id ' + productId + '.');
    console.error('Updating ai_failed to 1. ai_processed_at will remain NULL.');

    await markProductProhibitedContent(productId);

    console.error('ai_failed was updated to 1 for product_id ' + productId + '.');

    await appendDebugRecord({
      record_type: 'product_result',
      status: 'prohibited_content',
      product: debugProductInput,
      model: SETTINGS.GOOGLE_MODEL,
      prompt_characters: userPrompt.length,
      requested_image_count: imageUrls.length,
      loaded_image_count: images.length,
      images_base64_mb: Number((images.reduce((sum, img) => sum + Number(img.base64Length || 0), 0) / 1024 / 1024).toFixed(3)),
      input_token_estimate: inputTokenEstimate,
      usage_metadata: usageMetadata,
      prompt_feedback: promptFeedback,
      raw_response: fullText,
      raw_response_characters: fullText.length,
      ai_processed_at_updated: false,
      ai_failed_value: 1
    });

    return 'prohibited_content';
  }

  let parsedJson = null;
  let jsonValidationError = null;
  let jsonRepair = {
    applied: false,
    repair_type: null,
    removed_text: '',
    removed_character_count: 0,
    parse_succeeded: false,
    validation_passed: false,
    db_saved: false
  };

  try {
    const extractionResult = extractJsonFromText(fullText);
    parsedJson = extractionResult.parsedJson;
    jsonRepair = extractionResult.repair;

    if (jsonRepair.applied) {
      console.warn(
        'JSON repair applied for product_id ' + productId +
        ': removed ' + jsonRepair.removed_character_count +
        ' extra trailing closing brace(s).'
      );
    }

    console.log('JSON parsed successfully.');

    validateProductIdMatchesRequest(parsedJson, productId);
    validateRequiredAiLanguages(parsedJson);
    validateRequiredAiCodes(parsedJson);
    validateRequiredAiNumericScores(parsedJson);
    validateAiCategorySelection(parsedJson, alibeeCategoryOptions);
    validateProductInsights(parsedJson);

    if (jsonRepair.applied) {
      jsonRepair.validation_passed = true;
      jsonRepairStats.detected += 1;
      jsonRepairStats.parsed_successfully += 1;
      jsonRepairStats.validation_passed += 1;
    }

    const bannedFindings = findBannedCopyPhrases(parsedJson);
    if (bannedFindings.length) {
      console.warn('Warning: banned copy phrases were found:');
      for (const finding of bannedFindings) {
        console.warn('- ' + finding);
      }
    }
  } catch (error) {
    if (error?.jsonRepair) {
      jsonRepair = error.jsonRepair;
    }

    if (jsonRepair.applied) {
      jsonRepairStats.detected += 1;
      if (jsonRepair.parse_succeeded) {
        jsonRepairStats.parsed_successfully += 1;
      }
      jsonRepairStats.rejected += 1;
    }

    jsonValidationError = error.message || String(error);
    console.error('JSON validation failed: ' + jsonValidationError);
    parsedJson = null;
  }

  if (!parsedJson) {
    console.log('No JSON file was saved because Gemini did not return valid JSON.');

    await appendDebugRecord({
      record_type: 'product_result',
      status: 'invalid_json_or_validation_failure',
      product: debugProductInput,
      model: SETTINGS.GOOGLE_MODEL,
      prompt_characters: userPrompt.length,
      requested_image_count: imageUrls.length,
      loaded_image_count: images.length,
      images_base64_mb: Number((images.reduce((sum, img) => sum + Number(img.base64Length || 0), 0) / 1024 / 1024).toFixed(3)),
      input_token_estimate: inputTokenEstimate,
      usage_metadata: usageMetadata,
      prompt_feedback: promptFeedback,
      raw_response: fullText,
      raw_response_characters: fullText.length,
      json_repair: jsonRepair,
      validation_error: jsonValidationError,
      ai_processed_at_updated: false,
      ai_failed_value: 0
    });

    return false;
  }

  let jsonPath = null;

  if (SETTINGS.SAVE_JSON_OUTPUT_FILE) {
    jsonPath = await saveJsonResultFile(productId, parsedJson);
  }

  const savedCount = await saveAiContentToDb(productId, parsedJson);
  await saveProductInsightsToDb(productId, parsedJson);
  await updateProductCategoriesInProductsDb(productId, parsedJson);
  await markProductAiProcessed(productId);

  if (jsonRepair.applied) {
    jsonRepair.db_saved = true;
    jsonRepairStats.saved_to_db += 1;
  }

  if (SETTINGS.SAVE_JSON_OUTPUT_FILE) {
    console.log('File saved:');
    console.log('JSON: ' + jsonPath);
  } else {
    console.log('JSON file output skipped.');
  }

  console.log('DB rows saved: ' + savedCount);
  console.log('Product insights saved for product_id: ' + productId);
  console.log('alibee_products categories updated for product_id: ' + productId);
  console.log('ai_processed_at and updated_at updated for product_id: ' + productId);

  await appendDebugRecord({
    record_type: 'product_result',
    status: 'success_db_saved',
    product: debugProductInput,
    model: SETTINGS.GOOGLE_MODEL,
    prompt_characters: userPrompt.length,
    requested_image_count: imageUrls.length,
    loaded_image_count: images.length,
    images_base64_mb: Number((images.reduce((sum, img) => sum + Number(img.base64Length || 0), 0) / 1024 / 1024).toFixed(3)),
    input_token_estimate: inputTokenEstimate,
    usage_metadata: usageMetadata,
    prompt_feedback: promptFeedback,
    raw_response: fullText,
    raw_response_characters: fullText.length,
    json_repair: jsonRepair,
    parsed_json_written_to_db: parsedJson,
    db_language_rows_saved: savedCount,
    json_output_file: jsonPath,
    ai_processed_at_updated: true,
    ai_failed_value: 0
  });

  return true;
}

async function processProductWithRetries(product, ai, systemPrompt, columnGuide, alibeeCategoryOptions) {
  let attempt = 0;

  while (attempt < SETTINGS.MAX_API_RETRIES) {
    try {
      return await processProduct(product, ai, systemPrompt, columnGuide, alibeeCategoryOptions);
    } catch (error) {
      await appendDebugRecord({
        record_type: 'processing_error',
        status: isRateLimitError(error) ? 'rate_limit_or_temporary_api_error' : 'processing_exception',
        product_id: String(product.product_id || ''),
        product_title: product.product_title || '',
        model: SETTINGS.GOOGLE_MODEL,
        attempt_number: attempt + 1,
        error: simplifyErrorForLog(error),
        ai_processed_at_updated: false
      });

      if (isRateLimitError(error)) {
        const quotaInfo = extractGeminiQuotaInfo(error);
        logShortError('Gemini API rate limit / quota error for product_id ' + product.product_id, error);


        attempt += 1;

        if (attempt >= SETTINGS.MAX_API_RETRIES) {
          console.error('API rate limit/quota issue is still active after max retries. Stopping batch now.');
          console.error('Last product_id: ' + product.product_id);
          console.error('ai_processed_at was NOT updated for this product.');
          return 'rate_limit_stop';
        }

        const backoffWaitMs = Math.min(
          SETTINGS.RATE_LIMIT_WAIT_MS * Math.pow(SETTINGS.RATE_LIMIT_BACKOFF_MULTIPLIER, attempt - 1),
          SETTINGS.MAX_RATE_LIMIT_WAIT_MS
        );

        const geminiRetryWaitMs = quotaInfo.retryDelaySeconds
          ? Math.ceil(quotaInfo.retryDelaySeconds * 1000) + 2000
          : null;

        const waitMs = geminiRetryWaitMs || backoffWaitMs;

        console.warn('API rate limit/quota issue detected for product_id ' + product.product_id + '. Attempt ' + attempt + ' of ' + SETTINGS.MAX_API_RETRIES + '.');
        console.warn('Waiting ' + Math.round(waitMs / 1000) + ' seconds before retrying...');
        await sleep(waitMs);
        continue;
      }

      console.error('Product failed: ' + product.product_id);
      logShortError('Non-rate-limit product error for product_id ' + product.product_id, error);
      return false;
    }
  }

  console.error('Product failed after max API retries: ' + product.product_id);
  return false;
}

// =====================================================
// 7) Main
// =====================================================

async function main() {
  validateSettings();
  await initializeDebugRunFile();

  console.log('Google model: ' + SETTINGS.GOOGLE_MODEL);
  console.log('DEBUG_MODE: ' + SETTINGS.DEBUG_MODE);
  console.log('IMAGE_LIMIT: ' + SETTINGS.IMAGE_LIMIT);
  console.log('BATCH_LIMIT: ' + SETTINGS.BATCH_LIMIT);
  console.log('MAX_PRODUCTS_PER_RUN: ' + SETTINGS.MAX_PRODUCTS_PER_RUN);

  const systemPrompt = await readTextFileRequired(SETTINGS.SYSTEM_PROMPT_FILE, 'system prompt');
  const columnGuide = await readTextFileRequired(SETTINGS.COLUMN_GUIDE_FILE, 'column guide');
  const alibeeCategoryOptions = await getAlibeeThreeLevelCategoryOptionsFromDb();
  console.log('Loaded ' + alibeeCategoryOptions.split(NL).length + ' three-level Alibee category option(s).');

  const ai = new GoogleGenAI({
    apiKey: SETTINGS.GEMINI_API_KEY
  });

  const singleProductId = String(process.argv[2] || '').trim();

  // אם הועבר PRODUCT ID בשורת הפקודה, מריצים מוצר אחד בלבד ויוצאים.
  // דוגמה:
  //   node --env-file=.env update_db_ai_clean_prompt_fixed.js 1005005245733077
  if (singleProductId) {
    console.log('Single product mode enabled.');
    console.log('Product ID argument: ' + singleProductId);

    const product = await getProductFromDb(singleProductId);

    if (!product) {
      throw new Error('Product was not found in DB: ' + singleProductId);
    }

    const ok = await processProductWithRetries(product, ai, systemPrompt, columnGuide, alibeeCategoryOptions);

    if (ok === true) {
      console.log('Single product completed successfully: ' + singleProductId);
      return;
    }

    if (ok === 'temporary_skip') {
      console.warn('Single product was temporarily skipped and ai_processed_at was NOT updated: ' + singleProductId);
      process.exitCode = 2;
      return;
    }

    if (ok === 'prohibited_content') {
      console.warn('Single product was blocked as PROHIBITED_CONTENT and ai_failed was set to 1: ' + singleProductId);
      return;
    }

    if (ok === 'rate_limit_stop') {
      console.error('Single product stopped because of API rate limit/quota: ' + singleProductId);
      process.exitCode = 3;
      return;
    }

    console.error('Single product failed and ai_processed_at was NOT updated: ' + singleProductId);
    process.exitCode = 1;
    return;
  }

  let totalProcessed = 0;
  let totalSaved = 0;
  let totalFailed = 0;
  let totalTemporarySkipped = 0;
  let totalProhibitedContent = 0;
  const skippedThisRun = new Set();
  let shouldStopBatch = false;
  let isWaitingForNewProducts = false;
  // הלולאה פועלת כ-Worker, או נעצרת לאחר MAX_PRODUCTS_PER_RUN הצלחות.
  while (true) {
    const hasRunLimit = SETTINGS.MAX_PRODUCTS_PER_RUN > 0;
    const remainingSuccessfulProducts = hasRunLimit
      ? SETTINGS.MAX_PRODUCTS_PER_RUN - totalSaved
      : SETTINGS.BATCH_LIMIT;

    if (hasRunLimit && remainingSuccessfulProducts <= 0) {
      console.log('');
      console.log('=========================================');
      console.log('Maximum products per run reached.');
      console.log('Successfully processed: ' + totalSaved);
      console.log('Failed: ' + totalFailed);
      console.log('Temporarily skipped: ' + totalTemporarySkipped);
      console.log('PROHIBITED_CONTENT: ' + totalProhibitedContent);
      console.log('Total attempts: ' + totalProcessed);
      console.log('=========================================');
      return;
    }

    const currentBatchLimit = hasRunLimit
      ? Math.min(SETTINGS.BATCH_LIMIT, remainingSuccessfulProducts)
      : SETTINGS.BATCH_LIMIT;

    const productsFromDb = await getUnprocessedProductsFromDb(currentBatchLimit);
    const products = productsFromDb.filter(product => !skippedThisRun.has(String(product.product_id)));

    // אם אין בכלל מוצרים חדשים ב-DB, ממתינים ומבדקים שוב (השימוש הוא בשניות עכשיו)
	if (!productsFromDb.length) {
		if (!isWaitingForNewProducts) {
    console.log('Waiting for new products...');
    isWaitingForNewProducts = true;
  }

  await sleep(SETTINGS.DB_POLL_INTERVAL_SEC * 1000);
  continue;
}

isWaitingForNewProducts = false;
	
    // אם נשארו רק מוצרים שדילגנו עליהם (כי התמונות לא ירדו למשל)
    if (!products.length) {
      console.log(`Only temporarily skipped products remain. Sleeping for ${SETTINGS.DB_POLL_INTERVAL_SEC} seconds before retrying them...`);
      skippedThisRun.clear(); 
      await sleep(SETTINGS.DB_POLL_INTERVAL_SEC * 1000); // הפונקציה מצפה למילישניות
      continue;
    }

    console.log('Loaded ' + products.length + ' unprocessed product(s) from DB for this pass.');

    for (const product of products) {
      totalProcessed += 1;

      const ok = await processProductWithRetries(product, ai, systemPrompt, columnGuide, alibeeCategoryOptions);

      if (ok === true) {
        totalSaved += 1;

        const progressSuffix = SETTINGS.MAX_PRODUCTS_PER_RUN > 0
          ? '/' + SETTINGS.MAX_PRODUCTS_PER_RUN
          : '';

        console.log('Run progress: ' + totalSaved + progressSuffix + ' successful product(s).');

        if (
          SETTINGS.MAX_PRODUCTS_PER_RUN > 0 &&
          totalSaved >= SETTINGS.MAX_PRODUCTS_PER_RUN
        ) {
          console.log('');
          console.log('=========================================');
          console.log('Run completed: product limit reached.');
          console.log('Successfully processed: ' + totalSaved);
          console.log('Failed: ' + totalFailed);
          console.log('Temporarily skipped: ' + totalTemporarySkipped);
          console.log('PROHIBITED_CONTENT: ' + totalProhibitedContent);
          console.log('Total attempts: ' + totalProcessed);
          console.log('=========================================');
          return;
        }
      } else if (ok === 'temporary_skip') {
        totalTemporarySkipped += 1;
        skippedThisRun.add(String(product.product_id));
      } else if (ok === 'prohibited_content') {
        totalProhibitedContent += 1;
      } else if (ok === 'rate_limit_stop') {
        totalFailed += 1;
        shouldStopBatch = true;
        break; // יוצא מלולאת ה-for כדי להמתין
      } else {
        totalFailed += 1;
      }

      if (SETTINGS.DELAY_BETWEEN_PRODUCTS_MS > 0) {
        await sleep(SETTINGS.DELAY_BETWEEN_PRODUCTS_MS);
      }
    }

    // אם עצרנו בגלל Rate Limit
    if (shouldStopBatch) {
      console.log(`Batch stopped because of API rate limit/quota. Sleeping for ${SETTINGS.DB_POLL_INTERVAL_SEC} seconds before retrying...`);
      await sleep(SETTINGS.DB_POLL_INTERVAL_SEC * 1000); // הפונקציה מצפה למילישניות
      shouldStopBatch = false; // נאפס כדי שהלולאה תחזור לעבוד
      continue;
    }
  }
}

main()
  .then(async () => {
    await appendDebugRecord({
      record_type: 'run_end',
      status: 'completed',
      json_repair_stats: jsonRepairStats
    });

    if (SETTINGS.DEBUG_MODE) {
      console.log('JSON repair summary:');
      console.log('- Detected: ' + jsonRepairStats.detected);
      console.log('- Parsed successfully: ' + jsonRepairStats.parsed_successfully);
      console.log('- Passed validation: ' + jsonRepairStats.validation_passed);
      console.log('- Saved to DB: ' + jsonRepairStats.saved_to_db);
      console.log('- Rejected: ' + jsonRepairStats.rejected);
    }
  })
  .catch(async error => {
    await appendDebugRecord({
      record_type: 'fatal_error',
      status: 'fatal_script_error',
      error: simplifyErrorForLog(error),
      json_repair_stats: jsonRepairStats
    });
    logShortError('Fatal script error', error);
    process.exit(1);
  });