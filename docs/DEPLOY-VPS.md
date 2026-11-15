# النشر على VPS

النسخة النهائية تعمل كعملية Node واحدة دائمة: Express + Socket.IO + ملف SQLite على قرص ثابت.
هذا هو الشكل الذي بُني له التطبيق (بث لحظي حقيقي، جلسات في قاعدة البيانات، وبيانات لا تُصفَّر).

## ١) مواصفات السيرفر

| البند | الحد الأدنى | الموصى به |
| --- | --- | --- |
| المعالج | ١ vCPU | ٢ vCPU |
| الذاكرة | ١ جيجا | ٢ جيجا |
| القرص | ١٠ جيجا | ٢٥ جيجا (النسخ الاحتياطية تكبر مع الوقت) |
| النظام | Ubuntu 22.04 / 24.04 LTS | نفسه |
| الشبكة | IP عام + دومين | دومين (HTTPS تلقائي) |

## ٢) التحضير

```bash
sudo apt update && sudo apt install -y curl git ufw
# Node 24 LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v24.x
```

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin elhelp
sudo mkdir -p /var/lib/elhelp/backups
sudo chown -R elhelp:elhelp /var/lib/elhelp
# The clone must be owned by the service account, or `npm ci` cannot write node_modules.
sudo mkdir -p /opt/elhelp-app && sudo chown elhelp:elhelp /opt/elhelp-app
```

## ٣) الكود والبناء

```bash
sudo -u elhelp git clone https://github.com/baakaarx/elhelp-app.git /opt/elhelp-app
cd /opt/elhelp-app
sudo -u elhelp npm ci
sudo -u elhelp npm run build          # server/dist + dashboard/dist
sudo -u elhelp npm run export:mobile  # نسخة الويب من تطبيق المهندس على /app
```

> `mobile/dist` يجب أن يكون موجودًا وقت البناء ليُقدَّم على `/app`، لذا نفّذ التصدير
> **قبل** إعادة تشغيل الخدمة. الأمر `npm run build` لا يصدّر الموبايل.

## ٤) الإعدادات

```bash
sudo -u elhelp cp /opt/elhelp-app/.env.example /opt/elhelp-app/server/.env
sudo -u elhelp nano /opt/elhelp-app/server/.env
```

```ini
NODE_ENV=production
PORT=3000
ADMIN_EMAIL=manager@your-company.com
ADMIN_PASSWORD=<١٢ حرفًا على الأقل، قيمة فريدة>
DB_PATH=/var/lib/elhelp/mandoub.db
RETENTION_DAYS=30
STALE_GPS_MINUTES=10
TIMEZONE=Africa/Cairo
ALLOWED_ORIGINS=https://tracking.your-company.com
```

```bash
sudo chmod 600 /opt/elhelp-app/server/.env
```

- أول تشغيل يُنشئ حساب المدير من `ADMIN_EMAIL` + `ADMIN_PASSWORD`. بعد ذلك لا يُعاد إنشاؤه،
  وتغيير كلمة المرور يتم من قاعدة البيانات مباشرة (أو بحذف الحساب وإعادة الإقلاع).
- `ALLOWED_ORIGINS` لا بد أن يطابق الدومين الفعلي، وإلا رُفضت طلبات المتصفح.

## ٥) الخدمة (systemd)

```bash
sudo cp /opt/elhelp-app/deploy/elhelp.service /etc/systemd/system/elhelp.service
sudo systemctl daemon-reload
sudo systemctl enable --now elhelp
systemctl status elhelp --no-pager
curl -fsS http://127.0.0.1:3000/api/health
```

## ٦) HTTPS (Caddy)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
sudo cp /opt/elhelp-app/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # ضع الدومين
sudo systemctl reload caddy
```

الدومين لازم يكون `A record` على IP السيرفر قبل تشغيل Caddy، وإلا فشل إصدار الشهادة.

## ٧) الجدار الناري

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

المنفذ `3000` يبقى مغلقًا من الخارج: Caddy هو الواجهة الوحيدة.

## ٨) النسخ الاحتياطي

```bash
sudo cp /opt/elhelp-app/scripts/backup-sqlite.sh /usr/local/bin/elhelp-backup
sudo chmod +x /usr/local/bin/elhelp-backup
sudo DB_PATH=/var/lib/elhelp/mandoub.db /usr/local/bin/elhelp-backup   # تجربة يدوية
sudo crontab -e    # 30 2 * * * DB_PATH=/var/lib/elhelp/mandoub.db /usr/local/bin/elhelp-backup
```

النسخ تُحفظ مضغوطة في `/var/lib/elhelp/backups` ويُحذف ما تخطى ١٤ يومًا.
**لا تنسخ ملف SQLite بـ`cp` أثناء العمل** — استخدم السكربت (`VACUUM INTO`) لضمان نسخة متسقة.

## ٩) التحديث

```bash
cd /opt/elhelp-app
sudo -u elhelp git pull
sudo -u elhelp npm ci
sudo -u elhelp npm run build
sudo -u elhelp npm run export:mobile
sudo systemctl restart elhelp
```

## ١٠) تطبيق الموبايل (APK)

الدليل الكامل في [`BUILD-APK.md`](BUILD-APK.md). أسرع طريق:

```bash
cd mobile
echo "EXPO_PUBLIC_API_URL=https://tracking.your-company.com" > .env
cd .. && ./scripts/build-apk.sh https://tracking.your-company.com
# الناتج: mobile/dist-android/elhelp-engineer-1.0.0-release.apk
```

- العنوان بيتحرق وقت البناء، فلازم يكون الدومين النهائي (HTTPS) مش `localhost`.
- البناء بيربط عنوان http تلقائيًا كمسموح (cleartext) لو السيرفر لسه بدون شهادة؛ مع HTTPS
  الإعداد بيرجع للوضع الآمن.
- على الهاتف: اسمح بالموقع **«السماح دائمًا»**، ومن إعدادات البطارية اختر **«بدون قيود»**،
  وإلا سيوقف أندرويد التتبع في الخلفية.
