# Railway

На проверке 16 сентября 2026 аккаунт показывал Trial expired. Оплата/изменение тарифа автоматически не выполнялись.

1. Восстановите доступ к Railway. New Project → Deploy from GitHub Repo → denchikdd/tradersdiary. Dockerfile обнаружится автоматически.
2. Создайте Volume, mount path /data. Одна реплика, без sleep/serverless для постоянной синхронизации.
3. Networking → Generate Domain.
4. Variables:

| Имя | Значение |
|---|---|
| APP_ORIGIN | точный https://ваш-домен.up.railway.app без / в конце |
| JOURNAL_DB_PATH | /data/journal.sqlite |
| JOURNAL_ENCRYPTION_KEY | случайные 32 байта hex, 64 символа |
| JOURNAL_SETUP_TOKEN | отдельный случайный код, минимум 24 символа |

NODE_ENV=production и PORT=8080 заданы в Dockerfile. Railway может переопределить PORT. Healthcheck: /api/journal/health.

Генерация секретов локально (запустите отдельно для каждого):
```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```
Не вставляйте их в репозиторий, скриншоты или чат. Сохраните ключ шифрования в менеджере паролей. После первого входа можно удалить JOURNAL_SETUP_TOKEN из Variables.

5. Redeploy, дождитесь healthcheck. Откройте сайт, введите setup token, задайте пароль и подключите первый read-only ключ.
6. Сверьте известный день, включая комиссии/funding, с отчётом биржи.

## Доступ бирж
Может понадобиться постоянный исходящий IP Railway и IP allowlist биржи. Убедитесь в доступности этой возможности на тарифе и выберите разрешённый биржей регион. Текущие адаптеры используют глобальные домены. Не включайте торговлю/вывод для обхода ошибки доступа.

## Backup
Настройте backup Volume. SQLite нужно копировать согласованно: остановите сервис или используйте SQLite backup/VACUUM INTO. Нельзя копировать только .sqlite при активном WAL. Ключ шифрования храните отдельно. Потеря ключа делает credentials нечитаемыми; не меняйте его без миграции.

После обновления проверьте healthcheck и сохранность подключений. Восстановления пароля через UI, ротации encryption key и многопользовательской изоляции в этой версии нет.
