export default function handler(req, res) {
  const { ML_APP_ID, ML_REDIRECT_URI } = process.env;
  const url = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${ML_APP_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;
  res.redirect(url);
}
