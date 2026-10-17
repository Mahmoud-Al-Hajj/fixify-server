a mobile marketplace app for Lebanon that connects customers with local tradespeople (plumbers, electricians, and so on). A customer picks a category, submits a service request with a preferred date and time slot, a provider accepts and completes it, and afterward the customer can leave a review that's tied to that finished job so it can't be faked.

## Rebuild the database

MySQL 9.1. Run from the repo root in PowerShell. `mysql.exe` is in
`C:\Program Files\MySQL\MySQL Server 9.1\bin`; add that folder to `PATH` or use
the full path. Each command asks for the root password.

```powershell
mysql -u root -p -e "CREATE DATABASE fixify CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
Get-Content schema.sql -Raw | mysql -u root -p fixify
Get-Content scripts/seed-demo.sql -Raw | mysql -u root -p fixify
```

`schema.sql` does not create or select a database, so it only ever loads into
the one named on the command line.

If startup logs `ECONNREFUSED`, MySQL is not running: start the `MySQL91`
service from an admin PowerShell (`Start-Service MySQL91`), or set it to start
automatically (`Set-Service MySQL91 -StartupType Automatic`).
