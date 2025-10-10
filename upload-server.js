// upload-server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("csv-parser");
const { Parser } = require("json2csv");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

const JUMPS_API = "https://api.jumpseller.com/v1/products/search.json";
const JUMPS_TOKEN = process.env.JUMPS_TOKEN; // configurado en Render

app.post("/upload", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;
  const updatedRows = [];

  try {
    const products = await new Promise((resolve, reject) => {
      const rows = [];
      fs.createReadStream(filePath)
        .pipe(csv())
        .on("data", data => rows.push(data))
        .on("end", () => resolve(rows))
        .on("error", reject);
    });

    for (const p of products) {
      const sku = p.sku || p.SKU || "";
      if (!sku) continue;

      try {
        const response = await axios.get(JUMPS_API, {
          params: { q: sku },
          auth: { username: JUMPS_TOKEN, password: "" }
        });
        const result = response.data?.products?.[0];
        if (result) p.price = result.price || p.price;
      } catch (err) {
        console.warn(`No se pudo actualizar SKU ${sku}:`, err.message);
      }

      updatedRows.push(p);
    }

    const parser = new Parser({ fields: Object.keys(updatedRows[0]) });
    const csvUpdated = parser.parse(updatedRows);

    res.header("Content-Type", "text/csv");
    res.attachment("productos_actualizados.csv");
    res.send(csvUpdated);
  } catch (err) {
    console.error("Error al procesar CSV:", err);
    res.status(500).send("Error al procesar el archivo");
  } finally {
    fs.unlinkSync(filePath);
  }
});

const PORT = process.env.PORT || 10001;
app.listen(PORT, () =>
  console.log(`Servidor de actualización corriendo en puerto ${PORT}`)
);
