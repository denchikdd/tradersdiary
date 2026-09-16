# Торговый журнал

Личный журнал торговли: календарь PnL, детализация по биржам и тикерам, PWA и серверная синхронизация.

## Локальный запуск
Node.js 24 LTS. Установите зависимости: `npm ci`. В двух терминалах запустите `npm run dev:api` и `npm run dev`.
Откройте http://localhost:5173/. Код первой настройки находится в `.journal-local/SETUP.txt`. Введите код, задайте пароль (от 12 символов), откройте «Биржи» и добавьте read-only ключ. Для Hyperliquid нужен публичный адрес кошелька.

Нельзя отправлять базы, `.journal-local`, `.env` и секреты в GitHub. Не запускайте dev-сервер публично.

## Поддержка
- Binance: HMAC read-only, USDⓈ-M журнал доходов и spot-исполнения по указанным парам.
- Bybit: HMAC read-only, UTA, spot/linear исполнения и linear журнал.
- OKX: Read-only key/secret/passphrase, SPOT/SWAP исполнения, SWAP журнал.
- Hyperliquid: публичный адрес, perpetual fills/funding; без приватного ключа.
- Gate.io, Bitget, Aster: адаптеры пока не реализованы; ввод ключей отключён.

Данные сохраняются порциями; очередь в SQLite продолжает работу после перезапуска. После первичной загрузки сервер проверяет обновления каждые 15 минут. Это версия для личного тестирования: реальные ключи ещё не использовались. Ограничения: [docs/BACKEND.md](docs/BACKEND.md).

## Railway
[Инструкция](docs/RAILWAY.md). Один сервер Next.js/Node и постоянный Volume /data, одна реплика.
Для сборки: `npm run build:railway`, запуска: `npm run start:railway`.
Проверки: `npm run test:server`, `node --experimental-strip-types --test lib/journal.test.ts`.

## Безопасность
Пароль scrypt, сессия HttpOnly/SameSite (Secure на production), Origin/CSRF-проверка и ограничение попыток входа. Ключи AES-256-GCM с привязкой к подключению; основной ключ вне базы. API никогда не возвращает ключи и не логирует запросы бирж. Только фиксированные адреса и read-only методы бирж.

Доступ к серверу и JOURNAL_ENCRYPTION_KEY позволяет оператору расшифровать ключи: это не end-to-end шифрование. Храните резервную копию ключа отдельно от базы. Service worker не кэширует API и финансовые данные.
