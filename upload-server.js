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
function toPrecioString(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  let s = String(raw).trim().replace(/\s/g, "");
  s = s.replace(";", "");
  // 1.234,56 -> 1234.56
  if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  // 65,89 -> 65.89
  else if (/^\d+,\d{2}$/.test(s)) {
    s = s.replace(",", ".");
  }
  // 65.89 -> 65.89
  else if (/^\d+\.\d{2}$/.test(s)) {
    // ok
  }
  // 999 -> 999
  else if (/^\d+$/.test(s)) {
    // ok
  }
  if (isNaN(Number(s))) return "";
  return s;
}
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
    let rows;
    if (filePath.endsWith('.csv')) {
      const workbook = xlsx.readFile(filePath, { type: "file", raw: false, FS: ";" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    } else {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    }
    const jsClient = createJumpsellerClient();
    const preview = [];
    for (const row of rows) {
      // Las claves de columna se mantienen como están, en mayúsculas
      const keys = {};
      for (const k of Object.keys(row)) keys[k.trim()] = row[k];
      const sku = keys["COD.INT"]?.toString().trim() || "";
      const precioRaw = keys["PRECIO"] || "";
      const precio = toPrecioString(precioRaw);
      const fechaRaw = keys["FECHA"] || "";
      const fecha = toDDMMYY(fechaRaw);

      let errorCodInt = "";
      if (!sku) errorCodInt = "Código vacío o ausente";
      else if (sku === "0") errorCodInt = "Código igual a 0";
      else if (!/^[A-Za-z0-9\-_]+$/.test(sku)) errorCodInt = "Contiene caracteres inválidos";
      else if (sku.length < 3) errorCodInt = "Código demasiado corto";
      else if (sku.length > 30) errorCodInt = "Código demasiado largo";

      let apiProduct = null;
      let apiStatus = null;
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
        cod_int: sku,
        precio: precio,
        fecha: fecha,
        jumpseller_id: apiProduct?.id || null,
        api_status: apiStatus || null,
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
      cod_int: sku,
      precio: priceNewRaw,
      fecha: dateNew,
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
    const precioParaEnviar = toPrecioString(priceNewRaw);

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

    // Actualizar precio si corresponde
    let priceOk = true;
    let priceResp = null;
    if (
      precioParaEnviar !== undefined &&
      precioParaEnviar !== null &&
      precioParaEnviar !== ""
    ) {
      try {
        const priceBody = {
          product: {
            price: Number(precioParaEnviar) || 0,
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

    // Actualizar el campo personalizado usando el endpoint correcto
    let fechaOk = true;
    let fechaResp = null;
    if (fieldId && fechaParaEnviar) {
      try {
        const fieldBody = {
          field: { value: fechaParaEnviar },
        };
        fechaResp = await jsClient.put(
          `/products/${productId}/fields/${fieldId}.json`,
          fieldBody
        );
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

// Servir index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Servidor escuchando en el puerto ${PORT}`)
);
