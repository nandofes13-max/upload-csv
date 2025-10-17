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
      const fecha = toDDMMYY(fechaRaw);

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
          console.log(`\n🔍 ===== BÚSQUEDA PARA COD.INT: "${sku}" =====`);
          
          // PROBAR 3 ENDPOINTS DIFERENTES SECUENCIALMENTE
          let data = null;
          let apiEndpoint = '';

          // Opción 1: Búsqueda general (actual)
          console.log(`📡 PRUEBA 1: Búsqueda general`);
          try {
            const resp1 = await jsClient.get(`/products/search.json`, { params: { query: sku } });
            apiStatus = resp1.status;
            data = resp1.data;
            apiEndpoint = '/products/search.json?query=214';
            console.log(`✅ Endpoint 1 - Productos encontrados: ${Array.isArray(data) ? data.length : '0'}`);
            
            // Mostrar estructura de los primeros resultados
            if (Array.isArray(data) && data.length > 0) {
              console.log(`📝 Primeros 3 productos del Endpoint 1:`);
              data.slice(0, 3).forEach((item, index) => {
                const product = item.product || item;
                console.log(`   ${index + 1}. SKU: "${product.sku}" - Nombre: "${product.name}"`);
              });
            }
          } catch (err) {
            console.log(`❌ Endpoint 1 falló:`, err.message);
          }

          // Si no encontró nada, probar Opción 2
          if (!data || (Array.isArray(data) && data.length === 0)) {
            console.log(`\n📡 PRUEBA 2: Búsqueda por SKU exacto`);
            try {
              const resp2 = await jsClient.get(`/products.json`, { params: { sku: sku, exact: true } });
              apiStatus = resp2.status;
              data = resp2.data;
              apiEndpoint = '/products.json?sku=214&exact=true';
              console.log(`✅ Endpoint 2 - Productos encontrados: ${Array.isArray(data) ? data.length : '0'}`);
              
              if (Array.isArray(data) && data.length > 0) {
                console.log(`📝 Productos del Endpoint 2:`);
                data.forEach((item, index) => {
                  const product = item.product || item;
                  console.log(`   ${index + 1}. SKU: "${product.sku}" - Nombre: "${product.name}"`);
                });
              }
            } catch (err) {
              console.log(`❌ Endpoint 2 falló:`, err.message);
            }
          }

          // Si todavía no encontró nada, probar Opción 3
          if (!data || (Array.isArray(data) && data.length === 0)) {
            console.log(`\n📡 PRUEBA 3: Búsqueda alternativa`);
            try {
              const resp3 = await jsClient.get(`/products.json`, { params: { search: sku } });
              apiStatus = resp3.status;
              data = resp3.data;
              apiEndpoint = '/products.json?search=214';
              console.log(`✅ Endpoint 3 - Productos encontrados: ${Array.isArray(data) ? data.length : '0'}`);
              
              if (Array.isArray(data) && data.length > 0) {
                console.log(`📝 Productos del Endpoint 3:`);
                data.forEach((item, index) => {
                  const product = item.product || item;
                  console.log(`   ${index + 1}. SKU: "${product.sku}" - Nombre: "${product.name}"`);
                });
              }
            } catch (err) {
              console.log(`❌ Endpoint 3 falló:`, err.message);
            }
          }

          console.log(`🎯 Endpoint usado finalmente: ${apiEndpoint}`);
          console.log(`🔍 ===== FIN BÚSQUEDA =====\n`);
          
          // Buscar coincidencia exacta en los resultados
          let found = null;
          if (Array.isArray(data) && data.length) {
            found = data.find(item => {
              const product = item.product || item;
              const productSku = product.sku || (product.variants && product.variants[0]?.sku);
              return productSku === sku;
            });
            if (found) found = found.product || found;
          } else if (data?.products?.length) {
            found = data.products.find(product => {
              const productSku = product.sku || (product.variants && product.variants[0]?.sku);
              return productSku === sku;
            });
          } else if (data?.product) {
            const productSku = data.product.sku || (data.product.variants && data.product.variants[0]?.sku);
            if (productSku === sku) {
              found = data.product;
            }
          } else if (data && typeof data === "object") {
            const arr = Object.values(data).flat().filter(Boolean);
            found = arr.find(product => {
              const productSku = product.sku || (product.variants && product.variants[0]?.sku);
              return productSku === sku;
            });
          }
          
          if (found) {
            apiProduct = normalizeProductFromApi(found);
            console.log(`🎉 PRODUCTO ENCONTRADO: ${apiProduct.name} (SKU: ${apiProduct.sku})`);
          } else {
            errorCodInt = "No encontrado en Jumpseller (SKU no coincide exactamente)";
            console.log(`❌ No se encontró producto con SKU exacto: "${sku}"`);
          }
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

    // Normalizar la fecha antes de enviar (por si viene como xx/xx/xxxx)
    const fechaParaEnviar = toDDMMYY(dateNew);

    // Obtener el id del campo "Fecha" para ese producto
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

    // --- LOG ANTES DE ACTUALIZAR ---
    console.log(`--- Producto antes de actualización: ID ${productId} ---`);
    console.log(JSON.stringify(productBefore, null, 2));
    console.log("-------------------------------");

    // Actualizar precio si corresponde
    let priceOk = true;
    let priceResp = null;
    if (
      priceNewRaw !== undefined &&
      priceNewRaw !== null &&
      priceNewRaw !== ""
    ) {
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

    // --- Actualizar el campo personalizado usando el endpoint correcto ---
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
        // LOG después de actualizar campo personalizado
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

// Servir index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Servidor escuchando en el puerto ${PORT}`)
);
