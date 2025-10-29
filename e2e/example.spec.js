// @ts-check
import { test, expect } from '@playwright/test';

test.describe('flashcrawl playground', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Flashcrawl Playground</title>
        </head>
        <body>
          <main>
            <h1>Flashcrawl</h1>
            <a href="#getting-started">Get started</a>
            <section id="getting-started">
              <h2>Installation</h2>
              <p>Run <code>npm install</code> to set things up.</p>
            </section>
          </main>
          <script>
            document.querySelector('a').addEventListener('click', (event) => {
              event.preventDefault();
              document.getElementById('getting-started').scrollIntoView();
            });
          </script>
        </body>
      </html>
    `);
  });

  test('has title', async ({ page }) => {
    await expect(page).toHaveTitle(/Flashcrawl/);
  });

  test('navigates to Getting Started section', async ({ page }) => {
    await page.getByRole('link', { name: 'Get started' }).click();
    await expect(page.getByRole('heading', { name: 'Installation' })).toBeVisible();
  });
});
