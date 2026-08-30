import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  dashboardUser: process.env.DASHBOARD_USER || 'admin',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || ''
};

if (!config.dashboardPassword) {
  console.warn('[STAVEN BLUE V1] DASHBOARD_PASSWORD is not set; set it in Railway Variables before exposing the dashboard.');
}
