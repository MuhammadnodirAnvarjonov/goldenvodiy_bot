# Golden Vodiy — Telegram bot + to'lov servisi

Klinika Telegram boti (bemor ro'yxati, onlayn navbat, Payme/Click to'lov) —
mustaqil servis. Klinika dasturi (backend + front) lokal tarmoqda ishlashda
davom etadi; bu servis internetga qaraydigan qismlarni bajaradi.

## Server joylashuvi

| Nima | Qiymat |
|---|---|
| Server | 87.192.253.47 (payments-deploy foydalanuvchisi) |
| Kod | `/srv/golden-vodiy-payments/current` |
| Port | `127.0.0.1:3100` (nginx `payments.goldenvodiyclinic.uz` dan proksi qiladi) |
| Servis | `sudo systemctl restart golden-vodiy-payments.service` |
| Holat | `sudo systemctl status golden-vodiy-payments.service` |

## Nima qiladi

1. **Telegram bot** (long-polling) — bemor telefon raqami bilan ro'yxatdan
   o'tadi, onlayn navbat oladi, navbatlarini ko'radi/bekor qiladi.
2. **Payme Merchant API** — `POST /api/payme`
   Callback: `https://payments.goldenvodiyclinic.uz/api/payme`
3. **Click SHOP API** — `POST /api/click` (Prepare va Complete bitta URL,
   `action` bilan ajratiladi). Callback: `https://payments.goldenvodiyclinic.uz/api/click`
4. Health: `GET /health` va `GET /api/health` -> `{"ok":true}`

To'lov o'tgach navbat izohiga "Тўланган" belgisi qo'yiladi va bemorga
Telegram orqali tasdiqlash xabari boradi. Payme/Click qaysi biri `.env` da
sozlangan bo'lsa, botda o'sha to'lov tugmalari chiqadi (ikkalasi ham bo'lishi mumkin).

## Baza bilan bog'lanish

Bot klinikaning MySQL bazasi bilan ishlaydi (patient, queue, inspection, user,
payme_transaction, click_transaction jadvallari). Klinika bazasi lokalda
turadi, shuning uchun **klinika serveridan VPS ga teskari SSH tunel** ochib
qo'yiladi — bitta baza, sinxronizatsiya kerak emas.

Klinika serverida (internetga chiqishi bor, Task Scheduler ga qo'yiladi):

```bash
ssh -N -R 3307:127.0.0.1:3306 payments-deploy@payments.goldenvodiyclinic.uz
```

Shunda VPS dagi bot `.env` da `DB_HOST=127.0.0.1`, `DB_PORT=3307` orqali
klinika bazasini ko'radi. Tunel uzilsa servis bazaga ulana olmay o'chadi,
systemd qayta ishga tushiraveradi — tunel qaytgach o'zi tiklanadi.

Klinika bazasida yangi jadval kerak: `click_transaction` — klinika backend
papkasida `db-migrate up` bajarilganda yaratiladi
(migrations/20260925090000-click-merchant-api.js).

## Yangilash (deploy)

```bash
# Lokal kompyuterdan:
scp -r src package.json package-lock.json payments-deploy@87.192.253.47:/srv/golden-vodiy-payments/current/

# Serverda:
cd /srv/golden-vodiy-payments/current
npm install
sudo systemctl restart golden-vodiy-payments.service
sudo systemctl status golden-vodiy-payments.service
```

`.env` fayli serverda `/srv/golden-vodiy-payments/current/.env` da turadi
(`.env.example` dan nusxa olib to'ldiriladi): `BOT_TOKEN`, `DB_*`, `PAYME_*`, `CLICK_*`.

## To'lov tizimlari kabinetlarига kiritiladigan ma'lumotlar

**Payme** (merchant.payme.uz):
- Endpoint: `https://payments.goldenvodiyclinic.uz/api/payme`
- Account maydoni: `queue_id`
- Beradi: `PAYME_MERCHANT_ID`, `PAYME_KEY`, `PAYME_TEST_KEY` -> `.env` ga

**Click** (merchant.click.uz):
- Prepare URL ham, Complete URL ham: `https://payments.goldenvodiyclinic.uz/api/click`
- Beradi: `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` -> `.env` ga
- Bot to'lov linki `transaction_param` sifatida `queue_id` yuboradi

## Klinika tomonida (bot serverga ko'chirilgach)

Klinika backend `.env` fayliga qo'shiladi:

```
BOT_POLLING=0
```

va backend qayta ishga tushiriladi. Shunda klinika dasturi botni long-polling
qilmaydi (aks holda ikkita polling Telegram 409 xatosini beradi), lekin natija
fayllarini bemorga yuborish (sendDocument) ishlashda davom etadi.

## Tekshirish

```bash
sudo systemctl status golden-vodiy-payments.service
curl http://127.0.0.1:3100/health                      # serverda
curl https://payments.goldenvodiyclinic.uz/api/health  # tashqaridan
```
