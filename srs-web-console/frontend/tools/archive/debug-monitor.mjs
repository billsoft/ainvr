import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/snap/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});

const page = await browser.newPage();
await page.goto('http://127.0.0.1:5173/monitor', { waitUntil: 'networkidle0', timeout: 15000 });

const info = await page.evaluate(() => {
  const asides = document.querySelectorAll('aside');
  const result = [];
  asides.forEach((a, i) => {
    result.push({
      index: i,
      className: a.className.slice(0,100),
      tag: a.tagName,
      childrenCount: a.children.length,
      liCount: a.querySelectorAll('li').length,
      btnCount: a.querySelectorAll('button').length,
      testidBtns: a.querySelectorAll('button[data-testid]').length,
      first200Chars: a.innerText?.slice(0, 200),
    });
  });
  return result;
});

console.log('Found asides:', info.length);
for (const a of info) {
  console.log(JSON.stringify(a, null, 2));
}

await browser.close();
