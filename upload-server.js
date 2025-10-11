const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Configurar Multer para subir archivos
const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    // Ejemplo de lectura del CSV
    const filePath = path.join(__dirname, file.path);
    const data = fs.readFileSync(filePath, 'utf-8');

    // Ejemplo de envío del contenido a una API externa
    // const response = await axios.post('https://api.tuservidor.com/procesar', { data });

    console.log('Archivo recibido:', file.originalname);
    res.json({ status: 'ok', message: 'Archivo procesado correctamente' });

    // Eliminar archivo temporal
    fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Error al procesar el archivo:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}`);
});
