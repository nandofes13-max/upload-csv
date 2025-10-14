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
// RUTA: confirmar y actualizar TODOS los productos
// ------------------
app.post("/confirm", async (req, res) => {
  const payload = req.body?.data;
  if (!Array.isArray(payload) || payload.length === 0)
    return res.status(400).json({ error: "No hay datos para actualizar" });

  const jsClient = createJumpsellerClient();

  // --- LOGAR PRODUCTO ESPECÍFICO ---
  try {
    const resp = await jsClient.get(`/products/14782189.json`);
    console.log(`--- Producto ID 14782189 ---`);
    console.log(JSON.stringify(resp.data, null, 2));
    console.log('-------------------------------');
  } catch (err) {
    console.error("Error al obtener el producto:", 14782189, err?.response?.status, err?.response?.data || err?.message);
  }
  // --- FIN LOG ---

  const results = [];

  for (const item of payload) {
    const { sku, price_new: priceNewRaw, date_new: dateNew, jumpseller_id: productId } = item;

    if (!productId) {
      results.push({ sku, ok: false, message: "Producto no encontrado en Jumpseller (no se actualiza)" });
      continue;
    }

    // Normalizar la fecha antes de enviar
    const fechaParaEnviar = toDDMMYY(dateNew);

    // 1) Obtener producto actual para leer sus 'fields'
    let productoFull = null;
    try {
      const getResp = await jsClient.get(`/products/${productId}.json`);
      productoFull = getResp.data?.product || getResp.data || null;
    } catch (e) {
      console.error(`Error GET producto antes de update SKU ${sku} ID ${productId}:`, e?.response?.status || e?.message);
    }

    if (!productoFull) {
      console.log(`⚠️ No se pudo obtener producto ${productId} — se omite actualización de campo Fecha para SKU ${sku}`);
      results.push({ sku, ok: false, message: "No se pudo obtener producto antes de update" });
      continue;
    }

    // 2) Buscar campo Fecha dentro de producto.fields (si existe)
    const campoFecha = (productoFull.fields || []).find(
      f => String(f.label).toLowerCase() === "fecha" || f.custom_field_id === 32703
    );

    // 3) Preparar body según lo que encontremos (id dinámico preferido, fallback custom_field_id)
    let body;
    if (campoFecha && campoFecha.id) {
      body = {
        product: {
          price: Number(String(priceNewRaw).replace(",", ".")) || 0,
          fields: [
            { id: campoFecha.id, value: fechaParaEnviar }
          ]
        }
      };
      console.log(`Usando field.id=${campoFecha.id} para actualizar Fecha del SKU ${sku}`);
    } else {
      body = {
        product: {
          price: Number(String(priceNewRaw).replace(",", ".")) || 0,
          fields: [
            { custom_field_id: 32703, value: fechaParaEnviar }
          ]
        }
      };
      console.log(`No se encontró campo 'Fecha' por field.id; usando custom_field_id=32703 como fallback para SKU ${sku}`);
    }

    // 4) Enviar PUT
    try {
      const putResp = await jsClient.put(`/products/${productId}.json`, body);
      console.log(`PUT resp ${putResp.status} para SKU ${sku} ID ${productId}`);
    } catch (err) {
      console.error(`Error PUT producto ${sku} ID ${productId}:`, err?.response?.status, err?.response?.data || err?.message);
      results.push({ sku, ok: false, message: "Error en PUT", details: err?.response?.data || err?.message });
      continue;
    }

    // 5) Verificar: GET de nuevo y comparar valor
    try {
      const verifyResp = await jsClient.get(`/products/${productId}.json`);
      const after = verifyResp.data?.product || verifyResp.data || null;
      const campoAfter = (after?.fields || []).find(f => f.label && String(f.label).toLowerCase() === "fecha" || f.custom_field_id === 32703);
      const valorAfter = campoAfter ? (campoAfter.value ?? campoAfter.value_id ?? null) : null;

      console.log(`Verificación SKU ${sku} - Fecha en tienda ahora: ${valorAfter} | Fecha enviada: ${fechaParaEnviar}`);

      if (valorAfter && String(valorAfter).trim() === String(fechaParaEnviar).trim()) {
        results.push({ sku, ok: true, status: 200, previous: productoFull, new_value: valorAfter });
        console.log(`✅ Fecha actualizada correctamente para SKU ${sku}`);
      } else {
        results.push({ sku, ok: false, status: 200, previous: productoFull, new_value: valorAfter, note: "PUT OK pero valor no cambió" });
        console.warn(`⚠️ PUT OK pero la tienda NO refleja el nuevo valor para SKU ${sku}`);
      }
    } catch (e) {
      console.error(`Error GET producto tras PUT SKU ${sku} ID ${productId}:`, e?.response?.status || e?.message);
      results.push({ sku, ok: false, message: "Error verificando post-PUT", details: e?.response?.data || e?.message });
    }
  } // <- fin del for

  res.json({ results });
}); // <- fin de app.post("/confirm")


// Servir index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
