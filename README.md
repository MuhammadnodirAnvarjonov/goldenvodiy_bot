# Golden Vodiy — Telegram bot servisi

Klinika Telegram boti (bemor ro'yxati, onlayn navbat, Payme to'lov) — mustaqil servis.
Klinika dasturi (backend + front) lokal tarmoqda ishlashda davom etadi; bu servis
internetga qaraydigan qismlarni bajaradi va serverda (goldenvodiyclinic.uz) turadi.

## Nima qiladi

1. **Telegram bot** (long-polling) — bemor telefon raqami bilan ro'yxatdan o'tadi,
   onlayn navbat oladi, navbatlarini ko'radi/bekor qiladi.
2. **Payme Merchant API** — `POST /payme` endpointi. Payme kassa shu manzilga
   so'rov yuboradi: `https://goldenvodiyclinic.uz/payme`

## Baza bilan bog'lanish

Bot klinikaning MySQL bazasi bilan ishlaydi (patient, queue, inspection, user,
payme_transaction jadvallari). Klinika bazasi lokalda turadi, shuning uchun
**klinika serveridan VPS ga teskari SSH tunel** ochib qo'yiladi — bitta baza,
sinxronizatsiya kerak emas:

Klinika serverida (internetga chiqishi bor):

```bash
# Windows (klinika server_pc) uchun doimiy tunel — autossh o'rnini bosuvchi
# oddiy variant: Task Scheduler ga qo'shib qo'yiladi (har daqiqada tekshiradi)
ssh -N -R 3307:127.0.0.1:3306 integrator@goldenvodiyclinic.uz
```

Shunda VPS dagi bot `.env` da `DB_HOST=127.0.0.1`, `DB_PORT=3307` orqali
klinika bazasini ko'radi. Tunel uzilsa bot bazaga ulana olmaydi va pm2 uni
qayta ishga tushiraveradi — tunel qaytgach o'zi tiklanadi.

> Muqobil: bazani VPS ning o'ziga ko'chirish — lekin unda klinika dasturi bilan
> baza ikkiga bo'linib qoladi (bemorlar/navbatlarni sinxronlash kerak bo'ladi).
> Tavsiya etilmaydi.

## Serverga o'rnatish (Ubuntu, 87.192.253.47)

```bash
# 1. Node.js 18+ va pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx
sudo npm i -g pm2

# 2. Kodni joylash
mkdir -p ~/goldenvodiy-bot && cd ~/goldenvodiy-bot
# (bot papkasi shu yerga ko'chiriladi: scp yoki git orqali)
npm install

# 3. Sozlash
cp .env.example .env
nano .env   # BOT_TOKEN, DB_*, PAYME_* qiymatlarini kiritish

# 4. Ishga tushirish
pm2 start src/server.js --name goldenvodiy-bot
pm2 save
pm2 startup   # server qayta yonganda avtomatik ishga tushishi uchun
```

## Domen va HTTPS (Payme uchun shart)

```bash
# DNS: goldenvodiyclinic.uz A yozuvi -> 87.192.253.47

# Nginx reverse proxy
sudo tee /etc/nginx/sites-available/goldenvodiyclinic.uz >/dev/null <<'EOF'
server {
    listen 80;
    server_name goldenvodiyclinic.uz www.goldenvodiyclinic.uz;

    location /payme {
        proxy_pass http://127.0.0.1:3010/payme;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    location /health {
        proxy_pass http://127.0.0.1:3010/health;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/goldenvodiyclinic.uz /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL (Let's Encrypt)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d goldenvodiyclinic.uz -d www.goldenvodiyclinic.uz
```

Payme kassa sozlamalarida endpoint: `https://goldenvodiyclinic.uz/payme`

## Klinika tomonida (bot ko'chirilgach)

Klinika backend `.env` fayliga qo'shiladi:

```
BOT_POLLING=0
```

va backend qayta ishga tushiriladi. Shunda klinika dasturi botni long-polling
qilmaydi (aks holda ikkita polling Telegram 409 xatosini beradi), lekin natija
fayllarini bemorga yuborish (sendDocument) ishlashda davom etadi.

## Tekshirish

```bash
pm2 logs goldenvodiy-bot          # "Bot ishga tushdi" va "Baza bilan aloqa" chiqishi kerak
curl http://127.0.0.1:3010/health # {"ok":true}
```
