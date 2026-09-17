# Серверная версия

## Архитектура
Node.js 24, встроенный node:sqlite, SQLite WAL на постоянном диске. Один владелец, один процесс и worker. Для нескольких пользователей/реплик потребуется PostgreSQL и распределённая очередь. Production использует Next.js, локальное превью — существующий Vinext с proxy к Node API.

Таблицы: connections (шифротекст), events (оригиналы и нормализованные события), jobs (курсоры, окна, повторы), snapshots (последний баланс/позиции), settings, sessions, login_attempts. Страница и курсор сохраняются транзакционно. Уникальность: connection_id/stream/external_id. Потоки fills и ledger разделены, чтобы не посчитать комиссии дважды.

## История
| Биржа | Импорт | Граница |
|---|---|---|
| Bybit | fills spot/linear, ledger linear | UTA, до 2 лет, 7-дневные окна и cursor |
| Binance | income USDⓈ-M, spot fills | income 3 месяца (берём 89 дней с запасом); spot требует полный список пар. Futures fills отдельно пока не загружаются |
| OKX | fills SPOT/SWAP, bills SWAP | 3 месяца (89 дней с запасом), billId |
| Hyperliquid | perpetual fills/funding | API ограничивает fills последними 10 000, spot-PnL не рассчитывается |
| Gate.io | spot fills, USDT futures account book (PnL/fees/funding) | импорт окнами; полнота зависит от retention API аккаунта |
| Bitget | USDT/USDC futures account bills, spot/futures balance | 89 дней; отдельный Read-Only ключ и passphrase |
| Aster | баланс Futures/spot stablecoins и журнал income через read-only API Wallet | V3 EIP-712: signer address + API Wallet private key; публичный Chain RPC не используется для приватных аккаунтов |
| KuCoin | USDT futures ledger, spot/futures balance | однодневные окна; ключ только с General/read, без transfer/withdrawal |
| MEXC | spot fills и futures deals перечисленных пар | spot — только последний месяц; futures — до 90 дней на окно |
| Lighter | текущий публичный баланс аккаунта | приватная история пока не импортируется: официальный signer требует отдельный API private key и account index |

«Доступная история загружена» — завершены запросы в допустимом окне API, а не восстановлена вся история аккаунта. Пустой ответ не доказывает отсутствие старых сделок. Старые данные потребуют архива биржи; CSV/ZIP-импорт пока не реализован. Classic Bybit и региональные API-домены не поддерживаются.

## PnL
Результат = realized PnL − fee + signed funding. Переводы не считаются прибылью. Bybit использует cashFlow/fee/funding торговых и расчётных событий, OKX инвертирует знак fee, Binance разбирает REALIZED_PNL/COMMISSION/FUNDING_FEE. Суммы хранятся строками; сервер использует BigInt fixed-point с 12 знаками. UI конвертирует в дробные центы для финального форматирования.

Календарь показывает фьючерсный PnL в USDT/USDC, условно 1:1 к USD. Это не историческая USD-переоценка. Другие валюты сохраняются, но исключаются с предупреждением. Bonus, insurance и отдельные типы rebates пока не входят в результат. Нужна сверка с биржевым отчётом.

Spot fills сохраняются, но без себестоимости начального остатка, комиссий в сторонних монетах и движений активов прибыль spot не рассчитывается. Проценты реальных данных считаются от текущего общего капитала всех подключённых счетов. Демо использует базу 25 000 USD.

Календарь группирует записи по дате, подключению, символу и валюте; их количество не равно числу закрытых сделок. «История» показывает отдельные fills, если адаптер их получает. CSV dashboard содержит записи PnL, не оригинальные fills.

## Следующие этапы
Сверка каждого нового адаптера на реальном read-only ключе с отчётом биржи, Lighter signer, Binance futures fills, Bitget spot fills, CSV-архивы, spot cost basis/FIFO, процентная доходность, исторические balances, отдельные deposits/withdrawals, orders, WebSocket. Последний snapshot не заменяет историю капитала.

## Документация API
- https://bybit-exchange.github.io/docs/v5/user/apikey-info
- https://bybit-exchange.github.io/docs/v5/order/execution
- https://bybit-exchange.github.io/docs/v5/account/transaction-log
- https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Income-History
- https://developers.binance.com/docs/wallet/account/api-key-permission
- https://www.okx.com/docs-v5/en/
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- https://www.gate.com/docs/developers/apiv4/en/
- https://www.bitget.com/api-doc/common/signature
- https://github.com/asterdex/api-docs
- https://www.kucoin.com/docs-new
- https://mexcdevelop.github.io/apidocs/spot_v3_en/
- https://mexcdevelop.github.io/apidocs/contract_v1_en/
- https://github.com/elliottech/lighter-python

