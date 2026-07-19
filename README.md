# AlibeePop 🐝

AlibeePop is a companion app for the main **AliBee** platform, designed specifically for affiliates. 
The app provides a fast, mobile-first, TikTok/Reels-style user interface that allows affiliates to view, filter, and select newly scraped products from AliExpress before they are published to the main audience.

## How It Works 💡

The application acts as a "triage and curation system" between the raw data gathered by the scraper and the final product database used by the main AliBee app:

1. **The Feed:** The app fetches products from the scraper's database table (`aliexpress_products`) that have not yet been curated (where `is_selected` is `0` or `NULL`).
2. **Like ❤️:** When an affiliate likes a product and clicks the Like button, two actions happen simultaneously on the server (wrapped in a single database transaction):
   - The entire product record (including pricing, images, and video links) is copied to the `alibee_products` table (the primary database for the main AliBee app).
   - The product is marked as selected in the scraper's table (`is_selected = 1`) so it won't appear in the curation feed again.
3. **Dislike ❌:** When an affiliate rejects a product, it is simply marked as discarded in the scraper's table (`is_selected = 2`) and is removed from the feed without being transferred to the main database.

## Tech Stack 🛠️

* **Frontend:** * React + TypeScript.
  * Vite for fast development and building.
  * `embla-carousel-react` for building the vertical scrolling feed (swiping between products) and horizontal scrolling (swiping through images/videos of a specific product).
* **Backend:**
  * PHP scripts communicating with the database via PDO.
  * MySQL Database (`ovvwhemy_Alibee_DB`) hosted on Bluehost.

## Backend API Structure 📂

The frontend communicates with 3 main PHP endpoints on the server:

* **`products_feed_paged.php`**: Responsible for fetching the product feed.
  - Supports pagination (loads 10 products per page).
  - Includes filters for categories, text search, and a toggle for "video-only" products.
  - Ensures only uncurated products are fetched (`is_selected IS NULL OR p.is_selected = 0`).
  - Fetches products in a randomized order (`ORDER BY RAND()`) to keep the discovery experience fresh.
* **`save_product.php`**: The endpoint triggered by the **Like** action.
  - Uses an `INSERT IGNORE INTO ... SELECT` query to copy the product data from `aliexpress_products` to `alibee_products`.
  - Updates the scraper table to set `is_selected = 1`.
  - Executes everything within a Transaction to ensure data integrity.
* **`dislike_product.php`**: The endpoint triggered by the **Dislike** action.
  - Updates the `is_selected` column in the `aliexpress_products` table to `2`.

## Local Development 💻

The `vite.config.ts` is already configured with a proxy that routes `/alibeepop` requests directly to the remote server, preventing CORS issues during local development. To run the app locally:

1. Install all dependencies:
   ```bash
   npm install