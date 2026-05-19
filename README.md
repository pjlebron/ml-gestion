# ML Gestión — Panel de ventas

Dashboard para vendedores de Mercado Libre. Ventas reales, margen neto y semáforo ROAS.

## Deploy en Vercel (5 pasos)

### 1. Subí el proyecto a GitHub
```bash
cd ml-gestion
git init
git add .
git commit -m "primer commit"
git remote add origin https://github.com/TU-USUARIO/ml-gestion.git
git push -u origin main
```

### 2. Importá en Vercel
- Entrá a vercel.com → New Project → importá el repo de GitHub

### 3. Configurá las variables de entorno en Vercel
En el panel de Vercel → Settings → Environment Variables:

| Variable | Valor |
|---|---|
| `ML_APP_ID` | Tu App ID de Mercado Libre |
| `ML_CLIENT_SECRET` | Tu nuevo Client Secret |
| `ML_REDIRECT_URI` | `https://TU-PROYECTO.vercel.app/api/auth` |

### 4. Actualizá el Redirect URI en Mercado Libre
En developers.mercadolibre.com.ar → tu app → URI de redirect:
`https://TU-PROYECTO.vercel.app/api/auth`

### 5. Deploy
Vercel despliega automáticamente. Abrís la URL y hacés clic en "Conectar con Mercado Libre".

## Estructura
```
/
├── public/index.html     ← Dashboard
├── api/
│   ├── login.js          ← Inicia OAuth (redirect a ML)
│   ├── auth.js           ← Callback OAuth (recibe el código)
│   ├── _token.js         ← Helper: leer y refrescar tokens
│   ├── ventas.js         ← GET /orders/search
│   ├── ads.js            ← GET /advertising/product_ads
│   └── me.js             ← Verifica si está autenticado
├── vercel.json
└── .env.example
```

## Agregar costo de productos
En el dashboard → Localidades, cargás las tarifas de envío.
Para agregar el costo de cada producto, editá el objeto `COSTOS` en `public/index.html`:
```js
let COSTOS = {
  'MLB123456': 9200,   // item_id de ML → costo en pesos
  'MLB789012': 5500,
};
```
Próximamente: pantalla de ABM de costos de productos.

## Notas
- Los tokens se guardan en una cookie HttpOnly (segura, no accesible desde JS)
- El refresh token se renueva automáticamente antes de expirar
- Los datos de localidades y costos se guardan en localStorage del navegador
