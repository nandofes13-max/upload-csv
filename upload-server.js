// -----------------------------
// upload-server.js
// -----------------------------

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// Servir archivos estáticos (HTML, CSS, JS) desde /public
// -----------------------------
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
// Configuración de Multer (para subir archivos CSV)
// -----------------------------
const upload = multer({ dest: "uploads/" });

// -----------------------------
// Ruta principal: muestra el formulario HTML
// -----------------------------
app.get("/", (req, res) => {
  // En lugar de enviar texto, ahora enviamos el index.html
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -----------------------------
// Ruta para subir y procesar CSV
// -----------------------------
app.post("/upload", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;
  const results = [];

  try {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", async () => {
        fs.unlinkSync(filePath); // elimina el archivo temporal

        res.json({
          message: "Archivo CSV procesado correctamente",
          rows: results.length,
          sample: results.slice(0, 5),
        });
      });
  } catch (error) {
    console.error("Error procesando CSV:", error);
    res.status(500).json({ error: "Error al procesar el archivo CSV" });
  }
});

// -----------------------------
// Puerto dinámico (Render usa process.env.PORT)
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
