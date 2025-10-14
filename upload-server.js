// upload-server.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const xlsx = require("xlsx");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const upload = multer({ dest: "uploads/" });

// --- Helpers ---
function toDDMMYY(raw) {
  if (raw === null || raw === undefined || raw === "") return "";

  // Si viene como número (serial Excel)
  if (typeof raw === "number") {
    const date = new Date(Math.round((raw - 25569) * 86400 * 1000));
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const yy = String(date.getUTCFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
  }

  if (raw instanceof Date) {
    const dd = String(raw.getDate()).padStart(2, "0");
    const mm = String(raw.getMonth() + 1).padStart(2, "0");
    const yy = String(raw.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
  }

  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    const yy = m[3].length === 4 ? m[3].slice(-2) : m[3];
    return `${dd}/${mm}/${yy}`;
  }

  return s;
}

// Crear cliente Jumpseller
function createJumpsellerClient() {
  const login = process.env.JUMPS_LOGIN;
  const token = process.env.JUMPS_TOKEN;
  if (!login || !token) throw new Error("Faltan JUMPS_LOGIN o JUMPS_TOKEN");
  return axios.create({
    baseURL: "https://api.jumpseller.com/v1",
    auth: { username: login, password: token },
    timeout: 30_000,
  });
}

// Normalizar producto de respuesta Jumpseller
function normalizeProductFromApi(obj) {
  const id = obj.id || obj.product_id || obj.product?.id || obj.id_product || null;
  const name = obj.name || obj.title || (obj.product && (obj.product.name || obj.product.title)) || "";
  const sku = obj.sku || obj.sku_code || (obj.variants && obj.variants[0]?.sku) || "";
  const price = obj.price || obj.price_with_currency || (obj.variants && obj.variants[0]?.price) || "";
  return { id, name, sku, price };
}

// ------------------
// RUTA: subida y previsualización
// ------------------
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se subió archivo" });

  const filePath = req.file.path;

  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    const jsClient = createJumpsellerClient();
    const preview = [];

    for (const row of rows) {
  const keys = {};
  for (const k of Object.keys(row)) keys[k.toLowerCase().trim()] = row[k];

  const skuRaw = keys["cod.int"] ?? keys["cod int"] ?? keys["codint"] ?? keys["codigo"] ?? keys["codigo interno"] ?? keys["cod"];
  const sku = skuRaw?.toString().trim() || "";
  const precioRaw = keys["precio"] || keys["price"] || keys["importe"] || "";
  const precio = precioRaw === "" ? "" : String(precioRaw).replace(/[^\d\.,-]/g, "").replace(",", ".");
  const fechaRaw = keys["fecha"] || keys["fecha actualizacion"] || keys["fecha actualización"] || keys["fecha_modificacion"] || "";
  const fecha = toDDMMYY(fechaRaw); // <-- normaliza a formato DD/MM/YY


  // 🧠 VALIDACIONES COD.INT
  let errorCodInt = "";

  if (!sku) {
    errorCodInt = "Código vacío o ausente";
  } else if (sku === "0") {
    errorCodInt = "Código igual a 0";
  } else if (!/^[A-Za-z0-9\-_]+$/.test(sku)) {
    errorCodInt = "Contiene caracteres inválidos";
  } else if (sku.length < 3) {
    errorCodInt = "Código demasiado corto";
  } else if (sku.length > 30) {
    errorCodInt = "Código demasiado largo";
  }

  let apiProduct = null;
  let apiStatus = null;

  // Si hay error en COD.INT, no busca en Jumpseller
  if (!errorCodInt) {
    try {
      const resp = await jsClient.get(`/products/search.json`, { params: { query: sku } });
      apiStatus = resp.status;
      const data = resp.data;
      let found = null;
      if (Array.isArray(data) && data.length) found = data[0];
      else if (data?.products?.length) found = data.products[0];
      else if (data?.product) found = data.product;
      else if (data && typeof data === "object") {
        const arr = Object.values(data).flat().filter(Boolean);
        if (arr.length) found = arr[0];
      }
      if (found) apiProduct = normalizeProductFromApi(found);
      else errorCodInt = "No encontrado en Jumpseller";
    } catch (err) {
      console.error("Error buscando SKU en Jumpseller:", sku, err?.response?.status, err?.message);
      errorCodInt = "Error consultando Jumpseller";
    }
  }

  preview.push({
    product_name: apiProduct?.name || "(no encontrado)",
    sku,
    price_new: precio,
    date_new: fecha,
    jumpseller_id: apiProduct?.id || null,
    api_status: apiStatus || null,
    error_cod_int: errorCodInt, // <-- NUEVA COLUMNA
  });
}


    fs.unlinkSync(filePath);
    return res.json({ preview });
  } catch (error) {
    console.error("Error procesando archivo:", error);
    try { fs.unlinkSync(filePath); } catch (e) {}
    return res.status(500).json({ error: error.message || "Error interno" });
  }
});

// ------------------
// RUTA: confirmar y actualizar TODOS los productos
// ------------------
app.post("/confirm", async (req, res) => {
  const payload = req.body?.data;
  if (!Array.isArray(payload) || payload.length === 0)
    return res.status(400).json({ error: "No hay datos para actualizar" });

  const jsClient = createJumpsellerClient();
  const results = [];

  for (const item of payload) {
    const { sku, price_new: priceNewRaw, date_new: dateNew, jumpseller_id: productId } = item;

    if (!productId) {
      results.push({ sku, ok: false, message: "Producto no encontrado en Jumpseller (no se actualiza)" });
      continue;
    }

    // Normalizar la fecha antes de enviar (por si viene como xx/xx/xxxx)
    const fechaParaEnviar = toDDMMYY(dateNew);

    // 🧩 Actualizar precio y campo personalizado "Fecha" (ID 32703)
    const body = {
      product: {
        price: Number(String(priceNewRaw).replace(",", ".")) || 0,
        fields: [
          {
            custom_field_id: 32703, // campo "Fecha" en Jumpseller
            value: fechaParaEnviar
          }
        ]
      }
    };

    console.log(`PUT → SKU ${sku} | ID ${productId} | Fecha enviada: ${fechaParaEnviar}`);

    try {
      const resp = await jsClient.put(`/products/${productId}.json`, body);
      results.push({ sku, ok: true, status: resp.status });
      console.log(`✅ Actualizado correctamente: ${sku}`);
    } catch (err) {
      console.error("❌ Error actualizando producto:", sku, productId, err?.response?.status, err?.response?.data || err?.message);
      results.push({
        sku,
        ok: false,
        status: err?.response?.status || null,
        message: err?.response?.data || err?.message,
      });
    }
  }

  return res.json({ results });
});

// Servir index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
