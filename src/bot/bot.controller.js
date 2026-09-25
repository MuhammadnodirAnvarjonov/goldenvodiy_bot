const patient = require('../services/patient.service');
const { Keyboard, InputFile } = require("grammy")
const fs = require('fs');
const path = require('path');
const { registerNavbat, mainMenu } = require('./navbat.bot');

const keyboard = new Keyboard()
    .requestContact("📱 Telefon raqamni yuborish")
    .row()
    .resized();
function botMessage(bot){
    bot.command("start",async (ctx) => {
        // Ro'yxatdan o'tgan bemorga qayta telefon so'ramaymiz — menyu ko'rsatamiz
        const model = await patient.getOneByChatId(ctx.chat.id).catch(() => null);
        if(model){
            return ctx.reply("Assalomu alaykum! Quyidagi menyudan foydalaning 👇", {
                reply_markup: mainMenu
            })
        }
        ctx.reply("Iltimos telefon raqamni yuboring", {
            reply_markup: keyboard
        })
    });
    bot.on('message:contact', async (ctx) => {
        try{
            let phone = ctx.message.contact.phone_number
            phone = phone.replace(/[^\d]/g, '')
            phone = phone.replace('998', '')
            const user = await patient.getOneByPhone(phone)
            if(user){
                const upt = await patient.patientChatIdUpdate(user.id, ctx.chat.id)
                if(upt){
                    await ctx.reply('✅ Dasturdan muvaffaqiyatli ro\'yhatdan o\'tdingiz. Endi onlayn navbat olishingiz mumkin 👇',{
                        reply_markup: mainMenu,
                      })
                }else{
                    await ctx.reply('❌ Dasturda ushbu raqam bo\'yicha ma\'lumot topilmadi')
                }
            }else{
                await ctx.reply('❌ Dasturda ushbu raqam bo\'yicha ma\'lumot topilmadi')
            }
        }catch(e){
            console.log(e)
            try {
                await ctx.reply("Xatolik yuz berdi. Iltimos qaytadan urinib ko'ring.")
            } catch (_) {}
        }
    })
    // Onlayn navbat handerlari — umumiy message handleridan OLDIN turishi shart,
    // aks holda menyu tugmalari umumiy handlerga tushib ketadi
    registerNavbat(bot);

    bot.on('message', async (ctx) => {
        let chat_id = ctx.chat.id
        const model = await patient.getOneByChatId(chat_id)
        if(!model){
            ctx.reply("Iltimos telefon raqamni yuboring", {
                reply_markup: keyboard
            })
        }else{
            ctx.reply("Quyidagi menyudan foydalaning 👇", {
                reply_markup: mainMenu
            })
        }
    })
}
class SendMessage {
    bot;
    connect(bot){
        this.bot = bot;
    }
    // Bemor nomidan xavfsiz fayl nomi yasaydi (Telegramda shu nom bilan ko'rinadi)
    buildDisplayName = (patientName, ext) => {
        let safeName = (patientName || 'natija')
            .toString()
            .trim()
            .replace(/[\\/:*?"<>|]+/g, ' ')
            .replace(/\s+/g, ' ');
        if (!safeName) safeName = 'natija';
        return `${safeName}${ext || ''}`;
    }

    // Oddiy matnli xabar yuborish (Payme to'lov bildirshnomalari uchun ham ishlatiladi)
    sendTextUser = async (chat_id, text) => {
        if (!this.bot || !chat_id) return false;
        try {
            await this.bot.api.sendMessage(chat_id, text);
            return true;
        } catch (err) {
            console.error('sendTextUser xato:', err.message);
            return false;
        }
    }

    sendFileUser = (file, chat_id, patientName) => {
        if (!this.bot || !chat_id) return;
        const ext = path.extname(file) || '.pdf';
        const displayName = this.buildDisplayName(patientName, ext);
        this.bot.api.sendDocument(chat_id, new InputFile(`./upload/${file}`, displayName)).then( async res => {
            const faylNomi = 'upload/' + file;

            // Faylni o'chirish
            await fs.unlink(faylNomi, (xato) => {
                if (xato) {
                    console.error(`Faylni o'chirishda xato yuz berdi: ${xato.message}`);
                } else {
                    console.log(`Fayl muvaffaqiyatli o'chirildi: ${faylNomi}`);
                }
            });
        }).catch(err => console.error('sendFileUser xato:', err.message));
    }

    // Yuborish natijasini kutish mumkin bo'lgan variant — hisobot jurnaliga yozish uchun kerak.
    // Fayl yuborilgach ./upload dan o'chiriladi. Natija: { ok, reason }
    sendFileUserAsync = async (file, chat_id, patientName) => {
        if (!this.bot) return { ok: false, reason: 'bot_off' };
        if (!chat_id) return { ok: false, reason: 'no_chat_id' };
        const faylNomi = 'upload/' + file;
        if (!fs.existsSync(faylNomi)) return { ok: false, reason: 'not_found' };
        const ext = path.extname(file) || '.pdf';
        const displayName = this.buildDisplayName(patientName, ext);
        try {
            await this.bot.api.sendDocument(chat_id, new InputFile(`./${faylNomi}`, displayName));
            fs.unlink(faylNomi, (xato) => {
                if (xato) {
                    console.error(`Faylni o'chirishda xato yuz berdi: ${xato.message}`);
                }
            });
            return { ok: true, reason: 'sent' };
        } catch (err) {
            console.error('sendFileUserAsync xato:', err.message);
            fs.unlink(faylNomi, () => {});
            return { ok: false, reason: 'error' };
        }
    }
}
const newSendMessage = new SendMessage()
module.exports = {
    botMessage,
    newSendMessage,
}
