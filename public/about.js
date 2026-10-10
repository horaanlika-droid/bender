// Лендинг: мелочи для Telegram Mini App и ссылки на бота.
'use strict';

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  if (tg.setHeaderColor) tg.setHeaderColor('#14161a');
  if (tg.setBackgroundColor) tg.setBackgroundColor('#14161a');
}

// Показываем кнопку «Написать боту», только если ссылка на бота задана (TG_BOT_URL).
document.querySelectorAll('.tg-bot-link').forEach((a) => {
  const href = a.getAttribute('href') || '';
  if (href && !href.includes('%TG_BOT_URL%')) {
    a.hidden = false;
    if (tg && tg.openTelegramLink) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        tg.openTelegramLink(href);
      });
    }
  }
});
