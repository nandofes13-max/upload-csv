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
  if (!raw) return "";
  if (typeof raw === "number") {
    const date = new Date((raw - 25569) * 86400 * 1000);
    return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getFullYear()).slice(-2)}`;
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    const yy = m[3].slice(-2);
    return `${dd}/${mm}/${yy}`;
  }
  return s;
}

function createJumpsellerClient() {
  const login = process.env.JUMPS_LOGIN;
  const token = process.env.JUMPS_TOKEN;
  return axios.create({
    baseURL: "https://api.jumpseller.com/v1",
    auth: { username: login, password: token },
    timeout: 30000,
  });
}

// --- RUTA: subida + previsualización ---
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se subió archivo" });

  const filePath = req.file.path;
  try {
    const workbook = xlsx.readFile(filePath);
    const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });

    const js = createJumpsellerClient();
    const preview = [];

    for (const row of sheet) {
      const sku = String(row["COD.INT"] || "").trim();
      const precioTxt = String(row["PRECIO"] || "").replace(",", ".");
      const precioNuevo = parseFloat(precioTxt) || 0;
      const fechaNueva = toDDMMYY(row["FECHA"]);

      if (!sku) continue;

      // Buscar en Jumpseller
      let producto = null;
      try {
        const resp = await js.get(`/products/search.json`, { params: { query: sku } });
        const data = resp.data;
        const found = Array.isArray(data) && data.length ? data[0] :
                      data.products?.[0] || data.product || null;

        if (found) {
          producto = {
            id: found.id,
            name: found.name,
            price_current: found.price || (found.variants?.[0]?.price ?? ""),
          };
        }
      } catch (err) {
        console.warn("No se encontró SKU:", sku);
      }

      preview.push({
        sku,
        product_name: producto ? producto.name : "(no encontrado)",
        price_current: producto ? producto.price_current : "",
        price_new: precioNuevo,
        date_new: fechaNueva,
        jumpseller_id: producto ? producto.id : null,
      });
    }

    fs.unlinkSync(filePath);
    return res.json({ preview });
  } catch (err) {
    console.error("Error procesando archivo:", err);
    try { fs.unlinkSync(filePath); } catch {}
    return res.status(500).json({ error: err.message });
  }
});

// --- RUTA: confirmar y actualizar ---
app.post("/confirm", async (req, res) => {
  const items = req.body?.data || [];
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Sin datos" });

  const js = createJumpsellerClient();
  const results = [];

  for (const item of items) {
    if (!item.jumpseller_id) continue;

    const body = {
      product: {
        price: Number(String(item.price_new).replace(",", ".")) || 0,
        custom_field_1_label: "Fecha",
        custom_field_1_value: item.date_new
      }
    };

    try {
      const resp = await js.put(`/products/${item.jumpseller_id}.json`, body);
      results.push({ sku: item.sku, ok: true, status: resp.status });
    } catch (err) {
      console.error("Error actualizando SKU:", item.sku, err.response?.data || err.message);
      results.push({ sku: item.sku, ok: false, message: err.response?.data || err.message });
    }
  }

  return res.json({ results });
});

// --- Ruta raíz ---
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
