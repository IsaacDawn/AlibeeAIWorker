# AliBee AI Worker

Background AI worker for enriching AliBee products with multilingual content, categories, product insights, and Gemini-powered analysis.

## Overview

AliBee AI Worker continuously reads unprocessed products from the AliBee MySQL database, sends product data and images to Google Gemini, validates the returned JSON, and saves the enriched content back to the database.

The worker currently generates content in:

* English
* Hebrew
* Arabic
* French
* Spanish
* Russian

It also assigns AliBee categories, calculates product-level scores, and creates structured marketing and audience insights.

## Main Features

* Continuous database polling
* Batch product processing
* Multilingual product names and descriptions
* Ten hashtags per supported language
* Three-level AliBee category classification
* Product image analysis
* Content sensitivity classification
* Audience and giftability classification
* Structured product insights
* Configurable Gemini model and generation settings
* MySQL database persistence
* Optional JSON output files
* JSONL debug logs for complete run analysis
* Safe recovery from trailing extra JSON closing braces
* `PROHIBITED_CONTENT` handling
* Temporary API and image-download error handling

## Product Selection

The worker processes products that match:

```sql
WHERE a.ai_processed_at IS NULL
  AND (a.ai_failed IS NULL OR a.ai_failed = 0)
```

Successfully processed products receive an `ai_processed_at` timestamp.

When Gemini blocks a product with `PROHIBITED_CONTENT`:

* A clear message is printed to the console.
* `ai_failed` is updated to `1`.
* `ai_processed_at` remains `NULL`.
* The product is not selected again during normal processing.

## Safe JSON Repair

Gemini occasionally returns a complete JSON object followed by one or more unnecessary closing braces.

Example:

```text
{
  "product_id": 123
}
}
```

The worker can safely remove only trailing extra `}` characters when:

* The root JSON object is already complete and balanced.
* The remaining characters contain only whitespace and extra closing braces.
* The repaired JSON passes `JSON.parse`.
* The returned `product_id` matches the product being processed.
* All required languages and fields pass validation.
* The database write succeeds.

The worker does not attempt to complete truncated JSON, invent missing data, or extract a nested language object.

## Debug Mode

Enable detailed run logging in `.env`:

```env
DEBUG_MODE=true
```

Debug files are written to:

```text
debug_logs/
```

Each run creates one JSONL file similar to:

```text
AI_DEBUG_RUN_2026-07-19T17-49-02-665Z.jsonl
```

The debug log may include:

* Product ID and original title
* Cleaned product description
* Image URLs and image counts
* Prompt, output, and total token usage
* Raw Gemini response
* Parsed and validated JSON
* JSON repair details
* Validation errors
* API and database errors
* Rows written to the database
* `ai_processed_at` status
* `ai_failed` status
* Final run statistics

Each line is an independent JSON object.

Disable debug logging for normal production runs:

```env
DEBUG_MODE=false
```

## Requirements

* Node.js 22 or newer recommended
* MySQL-compatible database
* Google Gemini API key
* Access to the AliBee database
* Internet access for Gemini requests and product image downloads

## Installation

Clone the repository:

```bash
git clone https://github.com/IsaacDawn/AlibeeAIWorker.git
cd AlibeeAIWorker
```

Install dependencies:

```bash
npm install
```

Create the local environment file:

```cmd
copy .env.example .env
```

Add the required credentials and settings to `.env`.

Never commit the real `.env` file.

## Environment Configuration

Example:

```env
GEMINI_API_KEY=

GOOGLE_MODEL=gemini-3.1-flash-lite

DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=

SYSTEM_PROMPT_FILE=prompts/system_prompt.txt
COLUMN_GUIDE_FILE=prompts/column_guide.txt

IMAGE_LIMIT=6
BATCH_LIMIT=20
MAX_PRODUCTS_PER_RUN=100
DB_POLL_INTERVAL_SEC=10
DELAY_BETWEEN_PRODUCTS_MS=15000

TEMPERATURE=0.6
TOP_P=0.95
MAX_OUTPUT_TOKENS=5000
RESPONSE_MIME_TYPE=application/json

USE_THINKING=false
USE_GOOGLE_SEARCH=false
SAVE_JSON_OUTPUT_FILE=true
COUNT_TOKENS_BEFORE_REQUEST=false

DEBUG_MODE=false
```

## Running the Worker

Run directly with Node.js:

```bash
node update_db_ai.js
```

On Windows, the included command file can also be used:

```cmd
start_ai.cmd
```

### Process One Product

To process a specific product ID:

```bash
node update_db_ai.js 1005005245733077
```

Single-product mode is useful for testing, debugging, or reprocessing a specific product.

## Project Structure

```text
AliBeeAIWorker/
├── prompts/
│   ├── system_prompt.txt
│   └── column_guide.txt
├── model_configs/
├── update_db_ai.js
├── start_ai.cmd
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
└── README.md
```

Generated local directories are intentionally excluded from Git:

```text
node_modules/
outputs/
debug_logs/
.env
*.log
GOOGLE_RESULT_*.json
```

## Output Files

When enabled:

```env
SAVE_JSON_OUTPUT_FILE=true
```

Validated Gemini results are written to:

```text
outputs/
```

These files are for local inspection and are not committed to Git.

## Error Handling

### Invalid JSON

Invalid or incomplete JSON is rejected and is not written to the database.

### Trailing Extra Closing Braces

A complete JSON object followed only by extra `}` characters may be repaired using the safe repair rules described above.

### `PROHIBITED_CONTENT`

The product is marked:

```text
ai_failed = 1
```

The worker continues processing other products.

### Temporary Gemini or Network Errors

Temporary failures such as rate limits, service unavailability, timeouts, or connection errors may be retried according to the configured retry settings.

### Image Download Failure

Products whose required images cannot be downloaded may be temporarily skipped without updating `ai_processed_at`.

## Security

* Never commit `.env`.
* Never commit API keys or database credentials.
* Use `.env.example` only as a configuration template.
* Rotate credentials immediately if they are exposed.
* Prefer secret managers when deploying the worker to a server or cloud environment.

## Notes

This repository contains the background AI processing service for the AliBee product discovery platform.

Related AliBee projects include:

* AliBee
* AliBeePop
* AliBeeCollector
* AliBeeAIWorker
