import express from "express";
import multer from "multer";
import xlsx from "xlsx";
import { createJumpsellerClient } from "./jumpseller-client.js";

const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 10000;

// --- Función para normalizar fecha ---
function toDDMMYY(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear()).slice(-2);
  return `${day}/${month}/${year}`;
}

// --- Ruta principal ---
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    const jsClient = createJumpsellerClient();

    const results = [];

    for (const row of data) {
      const sku = row["COD. INT"];
      const priceNewRaw = row["PRECIO"];
      const dateNew = row["Custom Field 1 Value"];

      if (!sku) continue;

      try {
        // Buscar el producto por SKU
        const searchResp = await jsClient.get(`/products.json?sku=${sku}`);
        const product = searchResp.data?.[0];
        if (!product) {
          console.log(`❌ No encontrado SKU ${sku}`);
          continue;
        }

        // Buscar el campo "Fecha" dentro del producto
        const campoFecha = product.fields?.find(
          f => f.label === "Fecha" || f.custom_field_id === 32703
        );

        if (!campoFecha) {
          console.log(`⚠️ SKU ${sku} no tiene campo 'Fecha'`);
          continue;
        }

        const fechaParaEnviar = toDDMMYY(dateNew);

        const body = {
          product: {
            price: Number(String(priceNewRaw).replace(",", ".")) || 0,
            fields: [
              {
                id: campoFecha.id, // dinámico según producto
                value: fechaParaEnviar
              }
            ]
          }
        };

        console.log(`PUT → SKU ${sku} | ID ${product.id} | Campo Fecha ID ${campoFecha.id} | Fecha enviada: ${fechaParaEnviar}`);

        await jsClient.put(`/products/${product.id}.json`, body);

        console.log(`✅ Actualizado correctamente: ${sku}`);
        results.push({ sku, status: "OK" });

      } catch (err) {
        console.error(`❌ Error al actualizar SKU ${sku}:`, err.response?.status, err.response?.data || err.message);
        results.push({ sku, status: "ERROR" });
      }
    }

    res.json({ success: true, updated: results.length });
  } catch (error) {
    console.error("❌ Error general:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Iniciar servidor ---
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  console.log("///////////////////////////////////////////////////////////");
});
