# Деплой на BotHost + Telegram

Лендинг и морда живут в `app.js` (Node 18+, **ноль зависимостей**) + `public/`.
BotHost клонирует репозиторий и поднимает `app.js` — и лендинг, и Mini App, и бота.

## Что где

| Файл | Роль |
|---|---|
| `app.js` | HTTP-статика из `public/`, `/health`, крошечный Telegram-бот (long polling) |
| `public/index.html` | **морда** — глаза и рот для планшета в голове |
| `public/about.html` | лендинг проекта |
| `package.json` | `npm start` → `node app.js` |
| `Dockerfile` | явная сборка для BotHost (рабочая папка вне `/app`, как в их FAQ) |

Переменные окружения (задаются в панели BotHost):

| Переменная | Зачем | Обязательна |
|---|---|---|
| `BOT_TOKEN` | токен бота от @BotFather | да (иначе только лендинг) |
| `WEBAPP_URL` | публичный адрес, напр. `https://bender.bothost.ru` — для кнопок и og:image | рекомендуется (без неё адрес выводится из Host-заголовка) |
| `TG_BOT_URL` | ссылка на бота, напр. `https://t.me/bender_prototype_bot` — кнопка «Написать боту» на лендинге | желательно |
| `PORT` | порт HTTP | задаёт платформа |

## Шаг 1. Бот в @BotFather

1. `/newbot` → имя и username (например `bender_prototype_bot`) → **токен сохранить, в Git не писать**.
2. `/setmenubutton` → кнопка меню «Морда» → URL: `https://<ваш-домен>/`
   (после шага 2, когда домен известен). Menu Button — самая удобная точка входа на iPad.

## Шаг 2. Проект на BotHost

1. Регистрация на [bothost.ru](https://bothost.ru/) → «Создать бота».
2. Платформа: **Telegram**, тип: **Node.js**, Git URL: `https://github.com/horaanlika-droid/bender`,
   ветка: `main` (или рабочая ветка — её можно указать в настройках).
3. Bot Token: вставить токен от BotFather (или задать `BOT_TOKEN` в переменных окружения).
4. Домен: поддомен `bothost.ru` (например `bender.bothost.ru`) — HTTPS выпускается автоматически.
   Записать его в `WEBAPP_URL`.
5. Деплой → в логах должно быть: `✅ Лендинг на порту 3000 (public: ...)`.
6. Проверка: `https://<домен>/health` → `{"ok":true,"bot":true}`.

## Шаг 3. Связка с Telegram

- Menu Button (шаг 1) открывает морду прямо в чате.
- Бот отвечает на `/start`, `/help`, `/status` и даёт две Mini App-кнопки: «Морда» и «О проекте».
- Автообновление: в панели BotHost есть Webhook URL → GitHub: Settings → Webhooks → Add webhook
  (JSON). Дальше деплой идёт при каждом пуше.

## Локальная проверка

```
node app.js                      # http://localhost:3000 — морда, /about.html — лендинг
BOT_TOKEN=... node app.js        # + бот
curl localhost:3000/health
```

## Подводные камни BotHost (учтены)

- Сборка с `Dockerfile` → рабочая папка `/usr/src/app`, **не** `/app`: на части нод `/app`
  монтируется из Git и затирает артефакты сборки (их справочник ошибок).
- В репозитории живут и Python-мозги (`brain/`), и витрина (`app.js` в корне). Для BotHost
  релевантен только Node-слой; `Dockerfile` копирует лишь `app.js` + `public/` + `package.json`.
- `requirements.txt` в корне не нужен: BotHost ставит его, если находит, и это ломает сборку
  не-Python проектов — не добавлять.
- Long polling (`getUpdates`) не требует webhook-URL бота — работает сразу после деплоя.
