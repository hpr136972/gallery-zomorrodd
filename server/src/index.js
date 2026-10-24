'use strict';
const os = require('node:os');
const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const app = createApp(config);
app.listen(config.port).then((port) => {
  console.log(`گالری زمرد - سرور روی پورت ${port} اجرا شد.`);
  console.log(`  همین کامپیوتر:  http://localhost:${port}/app/   (پنل مدیر: http://localhost:${port}/admin)`);
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  for (const ip of ips) console.log(`  گوشی (همان Wi-Fi):  http://${ip}:${port}/app/`);
  if (!ips.length) console.log('  آدرس شبکه پیدا نشد؛ به Wi-Fi یا شبکه وصل شوید.');
  if (config.demoMode) console.log('[هشدار] DEMO_MODE فعال است؛ داده‌ها آزمایشی‌اند و برای امور مالی واقعی مناسب نیستند.');
  if (config.smsMode === 'dev') console.log('[هشدار] SMS_MODE=dev: پیامک واقعی ارسال نمی‌شود و کد در پاسخ API برمی‌گردد.');
  if (!config.production) console.log('[هشدار] ارتباط HTTP ساده است؛ در محیط واقعی پشت HTTPS (مثلاً nginx) اجرا کنید.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
