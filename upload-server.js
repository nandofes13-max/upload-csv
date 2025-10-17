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

// --- NUEVA FUNCIÓN: búsqueda exacta usando search.json y listado de resultados ---
async function findProductByExactSKU(jsClient, sku) {
  try {
    if (!sku || typeof sku !== "string" || sku.trim() === "") return null;

    const resp = await jsClient.get(`/search.json`, { params: { q: sku } });
    const products = resp.data?.products || [];

    console.log(`🔍 Resultados devueltos por search.json para "${sku}" (${products.length} encontrados):`);
    products.slice(0, 100).forEach((p, i) => {
      console.log(
        `${String(i + 1).padStart(2, "0")}. ID: ${p.id} | SKU: ${p.sku} | Nombre: ${p.name}`
      );
    });

    const exactMatch = products.find((p) => {
      const productSku = String(p.sku || "").trim().toLowerCase();
      const excelSku = String(sku).trim().toLowerCase();
      return productSku === excelSku;
    });

    if (exactMatch) {
      console.log(`✅ Coincidencia exacta encontrada para SKU "${sku}" → ID ${exactMatch.id}`);
      return normalizeProductFromApi(exactMatch);
    } else {
      console.log(`⚠️ No se encontró coincidencia exacta para SKU "${sku}"`);
      return null;
    }
  } catch (error) {
    console.error(`❌ Error al buscar SKU ${sku}:`, error.message);
    return null;
  }
}

// ------------------
// RUTA: subida y previsualización
// ------------------
app.post("/upload", multer({ dest: "uploads/" }).single("file"), async (req, res) => {
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
      const fecha = toDDMMYY(fechaRaw);

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

      if (!errorCodInt) {
        apiProduct = await findProductByExactSKU(jsClient, sku);
        if (!apiProduct) errorCodInt = "No encontrado en Jumpseller";
      }

      preview.push({
        product_name: apiProduct?.name || "(no encontrado)",
        sku,
        price_new: precio,
        date_new: fecha,
        jumpseller_id: apiProduct?.id || null,
        api_status: apiProduct ? 200 : null,
        error_cod_int: errorCodInt,
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
    const {
      sku,
      price_new: priceNewRaw,
      date_new: dateNew,
      jumpseller_id: productId,
    } = item;

    if (!productId) {
      results.push({
        sku,
        ok: false,
        message: "Producto no encontrado en Jumpseller (no se actualiza)",
      });
      continue;
    }

    const fechaParaEnviar = toDDMMYY(dateNew);

    let fieldId = null;
    let productBefore = null;
    try {
      const productResp = await jsClient.get(`/products/${productId}.json`);
      productBefore = productResp?.data;
      const fieldsArr =
        productResp?.data?.product?.fields ||
        productResp?.data?.fields ||
        [];
      const fieldFecha = fieldsArr.find(
        (f) =>
          (f.custom_field_id === 32703 || f.label === "Fecha") &&
          (!f.variant_id || f.variant_id === null)
      );
      if (fieldFecha) fieldId = fieldFecha.id;
    } catch (err) {
      console.error(
        `No se pudo obtener el campo "Fecha" para producto ${productId}:`,
        err?.response?.status,
        err?.message
      );
    }

    console.log(`--- Producto antes de actualización: ID ${productId} ---`);
    console.log(JSON.stringify(productBefore, null, 2));
    console.log("-------------------------------");

    let priceOk = true;
    let priceResp = null;
    if (priceNewRaw !== undefined && priceNewRaw !== null && priceNewRaw !== "") {
      try {
        const priceBody = {
          product: {
            price: Number(String(priceNewRaw).replace(",", ".")) || 0,
          },
        };
        priceResp = await jsClient.put(
          `/products/${productId}.json`,
          priceBody
        );
      } catch (err) {
        priceOk = false;
        console.error(
          "Error actualizando precio:",
          sku,
          productId,
          err?.response?.status,
          err?.response?.data || err?.message
        );
      }
    }

    let fechaOk = true;
    let fechaResp = null;
    if (fieldId && fechaParaEnviar) {
      try {
        const fieldBody = { field: { value: fechaParaEnviar } };
        fechaResp = await jsClient.put(
          `/products/${productId}/fields/${fieldId}.json`,
          fieldBody
        );
        console.log(
          `--- PUT campo personalizado Fecha: Producto ID ${productId} / Field ID ${fieldId} ---`
        );
        console.log(JSON.stringify(fechaResp.data, null, 2));
        console.log("-------------------------------");
      } catch (err) {
        fechaOk = false;
        console.error(
          "Error actualizando campo Fecha:",
          sku,
          productId,
          fieldId,
          err?.response?.status,
          err?.response?.data || err?.message
        );
      }
    } else if (!fieldId && fechaParaEnviar) {
      fechaOk = false;
      console.error(
        `No se encontró el fieldId para el campo Fecha en el producto ${productId}`
      );
    }

    results.push({
      sku,
      ok: priceOk && fechaOk,
      status: { price: priceResp?.status, fecha: fechaResp?.status },
      data: { price: priceResp?.data, fecha: fechaResp?.data },
    });
  }

  return res.json({ results });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Servidor escuchando en el puerto ${PORT}`)
);
