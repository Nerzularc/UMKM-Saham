@echo off
cd /d "%~dp0"
> diag.log 2>&1 (
  echo === node ===
  node -v
  npm -v
  echo === docker ===
  where docker
  docker info --format "{{.ServerVersion}}"
  echo === psql ===
  where psql
  dir /b "C:\Program Files\PostgreSQL" 
  echo === services ===
  sc query state= all | findstr /i "postgres"
  echo === port 5432 ===
  netstat -ano | findstr ":5432"
  echo === files ===
  if exist .env (echo env-present) else (echo env-missing)
  if exist node_modules (echo node_modules-present) else (echo node_modules-missing)
  echo === done ===
)
