import express from "express";
import multer from "multer";
import cors from "cors";
import XLSX from "xlsx";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.static("public"));
app.use(express.json());

// Para obtener la ruta actual (por módulos ES)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuración de Multer para subir el archivo Excel
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// Variables de entorno (Render)
const JUMPS_LOGIN = process.env.JUMPS_LOGIN;
const JUMPS_TOKEN = process.env.JUMPS_TOKEN;

// Ruta para servir el HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Subida y previsualización del archivo Excel
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

    // Leer columnas correctas
    const productos = sheet
      .filter(row => row["COD.INT"] && row["PRECIO"])
      .map(row => {
        const precioTexto = String(row["PRECIO"]).replace(",", "."); // convierte 32,54 → 32.54
        const precioNumero = parseFloat(precioTexto);

        // Fecha en formato DD/MM/AA
        let fechaFormateada = "";
        if (row["FECHA"]) {
          const partes = row["FECHA"].split("/");
          if (partes.length === 3) {
            fechaFormateada = `${partes[0].padStart(2, "0")}/${partes[1].padStart(2, "0")}/${partes[2]}`;
          }
        }

        return {
          sku: String(row["COD.INT"]).trim(),
          nuevoPrecio: precioNumero,
          fechaOriginal: fechaFormateada,
        };
      });

    console.log("Productos leídos:", productos);

    fs.unlinkSync(filePath); // borrar archivo temporal

    if (!productos.length) {
      return res.status(400).json({ message: "No se encontraron productos válidos en el archivo." });
    }

    res.json({ productos });
  } catch (error) {
    console.error("Error al procesar archivo:", error);
    res.status(500).json({ message: "Error al procesar el archivo Excel." });
  }
});

// Confirmar y actualizar productos en Jumpseller
app.post("/actualizar", async (req, res) => {
  try {
    const { productos } = req.body;
    const actualizados = [];

    for (const producto of productos) {
      const sku = producto.sku;
      const nuevoPrecio = producto.nuevoPrecio;
      const fecha = producto.fechaOriginal;

      // Buscar producto por SKU
      const searchUrl = `https://api.jumpseller.com/v1/products.json?login=${JUMPS_LOGIN}&authtoken=${JUMPS_TOKEN}`;
      const { data: productosData } = await axios.get(searchUrl);
      const encontrado = productosData.find(p => p.product.sku === sku);

      if (!encontrado) {
        console.log(`❌ Producto con SKU ${sku} no encontrado`);
        continue;
      }

      const productId = encontrado.product.id;

      // Actualizar producto
      const updateUrl = `https://api.jumpseller.com/v1/products/${productId}.json?login=${JUMPS_LOGIN}&authtoken=${JUMPS_TOKEN}`;
      const payload = {
        product: {
          price: nuevoPrecio,
          custom_fields: [
            { label: "Fecha", value: fecha },
          ],
        },
      };

      await axios.put(updateUrl, payload);
      console.log(`✅ Producto ${sku} actualizado → $${nuevoPrecio} / Fecha ${fecha}`);
      actualizados.push(sku);
    }

    res.json({ message: "Actualización completa", actualizados });
  } catch (error) {
    console.error("Error al actualizar productos:", error);
    res.status(500).json({ message: "Error al actualizar productos en Jumpseller." });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
