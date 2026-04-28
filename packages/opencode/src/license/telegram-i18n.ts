/**
 * Tiny i18n layer for the Telegram bot.
 *
 * The Telegram API gives us `from.language_code` on every message — a short
 * ISO 639-1 code (or a locale like "en-US"). We pick the user's language
 * once per message and thread a `Lang` value through the handler functions
 * that produce customer-facing text. Admin messages stay English; the bot's
 * admin surface is internal.
 */

export type Lang = "en" | "it"

export function pickLang(languageCode: string | undefined | null): Lang {
  if (!languageCode) return "en"
  const lc = languageCode.toLowerCase()
  if (lc === "it" || lc.startsWith("it-")) return "it"
  return "en"
}

const HELP_USER_EN = `🔥 *Welcome to CrimeCode* 🔥

The IDE built for fraud researchers and security pros — by the team, for the team.

🏷️ *Plans*

⚡ *Monthly* — *$20 / month*
   Try the platform. All Pro features unlocked, cancel anytime.

🔥 *Annual* — *$200 / year* _(save ~17%)_
   For serious users. Two months free vs paying monthly.

💎 *Lifetime* — *$500 once* _(best value)_
   Pay once, keep forever. All future updates included.

📋 *How it works (fully automated)*

*1.* Run \`/order monthly\` — _or_ \`annual\` _or_ \`lifetime\`.
*2.* The bot replies with three wallets (BTC / LTC / ETH) and the *exact* amount to send for each.
*3.* Send the EXACT amount to ANY one of those wallets.
*4.* As soon as the transaction is confirmed on-chain (~1–15 min) you receive your license token here automatically. ⚡

📌 *Useful commands*
\`/start\` — show this message
\`/order monthly|annual|lifetime\` — create a new order
\`/status <order_id>\` — check the status of one of your orders
\`/myorders\` — list your last orders
\`/mylicense\` — re-fetch your activation token (auto-applied on login)
\`/referral\` — your invite code + bonus-trial-days history
\`/teams\` — list your teams

🔁 *Account & sync*
\`/devices\` — list devices currently signed in to your account
\`/logout\` — sign out everywhere (kicks every active device)
\`/sync\` — show your cloud-sync status (events stored, last activity)

🔒 *Privacy*
We store only your Telegram handle, your order, and the license token signature. No email, no card data, no KYC.

🆘 *Need a human?* Message @OpCrime1312 or @JollyFraud — quote your order ID.`

const HELP_USER_IT = `🔥 *Benvenuto su CrimeCode* 🔥

L'IDE costruito per ricercatori di frodi e professionisti della sicurezza — dal team, per il team.

🏷️ *Piani*

⚡ *Mensile* — *$20 / mese*
   Prova la piattaforma. Tutte le feature Pro sbloccate, disdici quando vuoi.

🔥 *Annuale* — *$200 / anno* _(risparmi ~17%)_
   Per utenti seri. Due mesi gratis rispetto al mensile.

💎 *A vita* — *$500 una tantum* _(miglior valore)_
   Paghi una volta sola, resta tuo per sempre. Tutti gli aggiornamenti futuri inclusi.

📋 *Come funziona (tutto automatico)*

*1.* Esegui \`/order monthly\` — _oppure_ \`annual\` _oppure_ \`lifetime\`.
*2.* Il bot risponde con tre wallet (BTC / LTC / ETH) e l'importo *esatto* da inviare su ciascuno.
*3.* Invia l'importo ESATTO a UNO qualsiasi di quei wallet.
*4.* Appena la transazione è confermata on-chain (~1–15 min) ricevi il token della licenza qui in automatico. ⚡

📌 *Comandi utili*
\`/start\` — mostra di nuovo questo messaggio
\`/order monthly|annual|lifetime\` — crea un nuovo ordine
\`/status <order_id>\` — controlla lo stato di un ordine
\`/myorders\` — elenca i tuoi ultimi ordini
\`/mylicense\` — re-invia il token di attivazione (applicato in automatico al login)
\`/referral\` — il tuo codice invito + storia dei bonus
\`/teams\` — elenca i tuoi team

🔁 *Account e sync*
\`/devices\` — elenca i dispositivi loggati nel tuo account
\`/logout\` — disconnetti tutti i dispositivi (kick everywhere)
\`/sync\` — mostra lo stato della sincronizzazione cloud (eventi salvati, ultima attività)

🔒 *Privacy*
Salviamo solo il tuo handle Telegram, il tuo ordine, e la firma del token di licenza. Nessuna email, nessuna carta, nessun KYC.

🆘 *Hai bisogno di una persona?* Scrivi a @OpCrime1312 o @JollyFraud — cita il tuo order ID.`

const ORDER_CREATED_EN = (orderId: string, interval: string, usd: number, walletLines: string, windowMin: number) =>
  `✅ *Order created!*\n\n` +
  `ID: \`${orderId}\`\n` +
  `Plan: *${interval}* — *$${usd} USD*\n` +
  `Status: *pending payment*\n\n` +
  `💸 *Pay with ANY of these wallets* — use the EXACT amount shown so the bot can match it back to your order:\n\n` +
  walletLines +
  `\n\n⏱ This order expires in *${windowMin} minutes*. As soon as the transaction is confirmed on-chain you'll receive your license token *here automatically*.\n\n` +
  `Need help? Contact @OpCrime1312 or @JollyFraud and quote order \`${orderId}\`.`

const ORDER_CREATED_IT = (orderId: string, interval: string, usd: number, walletLines: string, windowMin: number) =>
  `✅ *Ordine creato!*\n\n` +
  `ID: \`${orderId}\`\n` +
  `Piano: *${interval}* — *$${usd} USD*\n` +
  `Stato: *in attesa di pagamento*\n\n` +
  `💸 *Paga con UNO qualsiasi di questi wallet* — usa l'importo ESATTO qui sotto così il bot riesce ad abbinarlo al tuo ordine:\n\n` +
  walletLines +
  `\n\n⏱ L'ordine scade tra *${windowMin} minuti*. Appena la transazione è confermata on-chain ricevi il token della licenza *qui in automatico*.\n\n` +
  `Hai bisogno di aiuto? Contatta @OpCrime1312 o @JollyFraud e cita l'ordine \`${orderId}\`.`

const TOKEN_DELIVERY_EN = (licenseId: string, interval: string, expLine: string, token: string) =>
  `🎉 *Your CrimeCode license is ready!*\n\n` +
  `License ID: \`${licenseId}\`\n` +
  `Plan: *${interval}*${expLine}\n\n` +
  `📋 *Activation*\n\n` +
  `Open the CrimeCode desktop app → on the Subscription screen click *"I have a token"* → paste the token below → click *Activate*.\n\n` +
  `\`${token}\`\n\n` +
  `(Tap to copy — keep it safe, this is your proof of purchase.)\n\n` +
  `Thanks for supporting CrimeCode 🖤`

const TOKEN_DELIVERY_IT = (licenseId: string, interval: string, expLine: string, token: string) =>
  `🎉 *La tua licenza CrimeCode è pronta!*\n\n` +
  `ID licenza: \`${licenseId}\`\n` +
  `Piano: *${interval}*${expLine}\n\n` +
  `📋 *Attivazione*\n\n` +
  `Apri l'app desktop CrimeCode → nella schermata Subscription clicca *"I have a token"* → incolla il token qui sotto → clicca *Activate*.\n\n` +
  `\`${token}\`\n\n` +
  `(Tocca per copiare — custodiscilo, è la tua prova d'acquisto.)\n\n` +
  `Grazie per supportare CrimeCode 🖤`

const NEW_DEVICE_EN = (deviceLabel: string, whenIso: string) =>
  `🔐 *New device signed in to your CrimeCode account*\n\n` +
  `Device: ${deviceLabel}\n` +
  `Time: ${whenIso}\n\n` +
  `If this wasn't you, open the desktop/web app → *Account* → *Sign out*, then change any shared credentials.`

const NEW_DEVICE_IT = (deviceLabel: string, whenIso: string) =>
  `🔐 *Nuovo dispositivo collegato al tuo account CrimeCode*\n\n` +
  `Dispositivo: ${deviceLabel}\n` +
  `Ora: ${whenIso}\n\n` +
  `Se non sei stato tu, apri l'app desktop/web → *Account* → *Sign out*, poi cambia eventuali credenziali condivise.`

const RENEWAL_REMINDER_EN = (licenseId: string, interval: string, daysLeft: number, urgent: boolean) => {
  const headline = urgent ? "⚠️ *License expiring TOMORROW*" : "⏳ *License renewal reminder*"
  return (
    `${headline}\n\n` +
    `Your CrimeCode Pro license \`${licenseId}\` (plan: *${interval}*) expires in *${daysLeft} day${daysLeft === 1 ? "" : "s"}*.\n\n` +
    `Renew now to avoid downtime — same wallet, same flow:\n\n` +
    `• \`/order monthly\` — *$20 / month*\n` +
    `• \`/order annual\` — *$200 / year* _(save 17%)_\n` +
    `• \`/order lifetime\` — *$500 once* _(best value, never expires)_\n\n` +
    `Need help? Message @OpCrime1312.`
  )
}

const RENEWAL_REMINDER_IT = (licenseId: string, interval: string, daysLeft: number, urgent: boolean) => {
  const headline = urgent ? "⚠️ *Licenza in scadenza DOMANI*" : "⏳ *Promemoria rinnovo licenza*"
  return (
    `${headline}\n\n` +
    `La tua licenza CrimeCode Pro \`${licenseId}\` (piano: *${interval}*) scade tra *${daysLeft} giorno${daysLeft === 1 ? "" : "i"}*.\n\n` +
    `Rinnova adesso per non perdere accesso — stesso wallet, stesso flow:\n\n` +
    `• \`/order monthly\` — *$20 / mese*\n` +
    `• \`/order annual\` — *$200 / anno* _(risparmi 17%)_\n` +
    `• \`/order lifetime\` — *$500 una tantum* _(miglior valore, non scade)_\n\n` +
    `Hai bisogno di aiuto? Scrivi a @OpCrime1312.`
  )
}

const PAYMENT_CONFIRMED_EN = (licenseId: string, interval: string, expLine: string, explorer: string, token: string) =>
  `✅ *Payment received on-chain!*\n\n` +
  `Order has been confirmed and your CrimeCode Pro license is ready.\n\n` +
  `License ID: \`${licenseId}\`\n` +
  `Plan: *${interval}*\n` +
  `${expLine}\n` +
  `Tx: ${explorer}\n\n` +
  `📋 *Activation*\n\n` +
  `Open the CrimeCode desktop app → on the Subscription screen click *"I have a license token"* → paste the token below → click *Activate*.\n\n` +
  `\`${token}\`\n\n` +
  `Thanks for supporting CrimeCode 🖤`

const PAYMENT_CONFIRMED_IT = (licenseId: string, interval: string, expLine: string, explorer: string, token: string) =>
  `✅ *Pagamento ricevuto on-chain!*\n\n` +
  `L'ordine è stato confermato e la tua licenza CrimeCode Pro è pronta.\n\n` +
  `ID licenza: \`${licenseId}\`\n` +
  `Piano: *${interval}*\n` +
  `${expLine}\n` +
  `Tx: ${explorer}\n\n` +
  `📋 *Attivazione*\n\n` +
  `Apri l'app desktop CrimeCode → nella schermata Subscription clicca *"I have a license token"* → incolla il token qui sotto → clicca *Activate*.\n\n` +
  `\`${token}\`\n\n` +
  `Grazie per supportare CrimeCode 🖤`

export function helpUser(lang: Lang): string {
  return lang === "it" ? HELP_USER_IT : HELP_USER_EN
}

export function orderCreatedMessage(
  lang: Lang,
  orderId: string,
  interval: string,
  usd: number,
  walletLines: string,
  windowMin: number,
): string {
  return (lang === "it" ? ORDER_CREATED_IT : ORDER_CREATED_EN)(orderId, interval, usd, walletLines, windowMin)
}

export function tokenDeliveryMessage(
  lang: Lang,
  licenseId: string,
  interval: string,
  expLine: string,
  token: string,
): string {
  return (lang === "it" ? TOKEN_DELIVERY_IT : TOKEN_DELIVERY_EN)(licenseId, interval, expLine, token)
}

export function newDeviceMessage(lang: Lang, deviceLabel: string, whenIso: string): string {
  return (lang === "it" ? NEW_DEVICE_IT : NEW_DEVICE_EN)(deviceLabel, whenIso)
}

export function renewalReminderMessage(
  lang: Lang,
  licenseId: string,
  interval: string,
  daysLeft: number,
  urgent: boolean,
): string {
  return (lang === "it" ? RENEWAL_REMINDER_IT : RENEWAL_REMINDER_EN)(licenseId, interval, daysLeft, urgent)
}

export function paymentConfirmedMessage(
  lang: Lang,
  licenseId: string,
  interval: string,
  expLine: string,
  explorer: string,
  token: string,
): string {
  return (lang === "it" ? PAYMENT_CONFIRMED_IT : PAYMENT_CONFIRMED_EN)(
    licenseId,
    interval,
    expLine,
    explorer,
    token,
  )
}

/**
 * Remember the preferred language for a chat so async/scheduled messages
 * (renewal reminders, new-device notifications, on-chain payment
 * confirmations) can use the same locale the user picked on their last
 * bot interaction. In-memory cache — cold start falls back to English
 * which is fine.
 */
const langByUser = new Map<number, Lang>()

export function rememberLang(userId: number, lang: Lang): void {
  langByUser.set(userId, lang)
}

export function recallLang(userId: number | null | undefined): Lang {
  if (!userId) return "en"
  return langByUser.get(userId) ?? "en"
}
