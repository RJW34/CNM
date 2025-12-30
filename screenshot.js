const puppeteer = require('puppeteer');
const path = require('path');

// iPhone 14 Pro Max viewport
const iPhone14ProMax = {
  width: 430,
  height: 932,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
};

async function takeScreenshot() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = path.join(__dirname, `screenshot-${timestamp}.png`);

  console.log('Launching browser...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--ignore-certificate-errors',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  try {
    const page = await browser.newPage();

    // Set iPhone viewport
    await page.setViewport(iPhone14ProMax);
    await page.setUserAgent(iPhone14ProMax.userAgent);

    // Navigate to the server
    const url = 'https://localhost:3001/?token=change-this-secret-token';
    console.log(`Navigating to ${url}...`);

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait a bit for animations and WebSocket connection
    console.log('Waiting for page to settle...');
    await new Promise(r => setTimeout(r, 3000));

    // Take screenshot
    console.log(`Taking screenshot: ${outputPath}`);
    await page.screenshot({
      path: outputPath,
      fullPage: false
    });

    console.log('Screenshot saved successfully!');
    return outputPath;

  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

takeScreenshot()
  .then(path => console.log(`\nScreenshot saved to: ${path}`))
  .catch(err => {
    console.error('Failed to take screenshot:', err);
    process.exit(1);
  });
