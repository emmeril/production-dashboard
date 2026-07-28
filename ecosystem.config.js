module.exports = {
  apps: [
    {
      name: 'production-dashboard',
      script: './server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '768M',
      time: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta'
      },
      env_production: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta'
      }
    }
  ]
};
