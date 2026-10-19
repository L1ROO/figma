# Lienzo

Editor de diseño tipo Figma, hecho para que Claude pueda leer y editar tus diseños por MCP sin límites de llamadas. Lo que Claude cambia aparece en vivo en el navegador, y lo que vos cambiás lo ve Claude.

## Qué tiene

- Lienzo infinito con zoom y desplazamiento (rueda, Ctrl+rueda, espacio + arrastrar, pellizco en pantallas táctiles).
- Frames, rectángulos, elipses, líneas, textos e imágenes (subir, pegar o arrastrar archivos).
- Mover, redimensionar (Shift mantiene proporción, Alt desde el centro), guías de alineación, alinear, agrupar, duplicar, copiar y pegar, ordenar capas.
- Panel de capas con arrastre para reordenar o meter dentro de frames, ocultar y bloquear.
- Panel de propiedades: posición, tamaño, rotación, radio, opacidad, relleno (colores o gradientes CSS), borde, sombra, tipografía (cualquier fuente de Google Fonts).
- Varias páginas por diseño, deshacer y rehacer, exportar a SVG.
- Servidor MCP con 14 herramientas, incluida una captura PNG para que Claude vea cómo quedó.

## Traer diseños de Figma (sin gastar tokens)

1. En Figma seleccioná el frame y en el panel derecho, en **Export**, elegí **SVG**.
2. En los tres puntos (…) de la exportación desmarcá **Outline text** y marcá **Include "id" attribute**. Así los textos quedan editables y las capas conservan su nombre.
3. Exportá y arrastrá el `.svg` al lienzo, o tocá **Importar**. También podés pegar el SVG con Ctrl+V.

La conversión la hace la página: frames, textos, rectángulos, elipses, líneas, degradados, sombras e imágenes quedan como capas editables. Los íconos y formas complejas quedan como imágenes vectoriales. Si querés soltar un SVG como imagen única, mantené Shift al arrastrarlo.

## Subirlo a Render

1. Subí esta carpeta a un repositorio de GitHub (sin `node_modules`).
2. En Render: **New → Blueprint**, elegí el repo. El archivo `render.yaml` crea solo la web y una base de datos Postgres.
3. Cuando termine, entrá al servicio **lienzo → Environment** y copiá el valor de `ACCESS_TOKEN`. Esa es tu clave.
4. Abrí la URL de tu servicio (`https://lienzo-xxxx.onrender.com`) y entrá con la clave.

Si preferís crearlo a mano: **New → Web Service**, Build `npm install`, Start `npm start`, y agregá las variables `ACCESS_TOKEN` (inventá una clave larga con letras y números) y `DATABASE_URL`.

## Conectar Claude

En Claude: **Configuración → Conectores → Agregar conector personalizado** y pegá:

```
https://TU-APP.onrender.com/mcp/TU_ACCESS_TOKEN
```

La misma URL aparece en la pantalla de inicio de la web y en el panel derecho del editor (con nada seleccionado), lista para copiar.

Después podés pedirle cosas como: "Abrí mi diseño en Lienzo, armá la pantalla de perfil de Swappit al lado de Inicio y mostrame una captura".

## Herramientas MCP

| Herramienta | Para qué |
|---|---|
| `list_documents`, `create_document` | Ver y crear diseños |
| `get_document` | Árbol de capas en texto compacto (gasta pocos tokens) |
| `get_nodes`, `find_nodes`, `export_node_json` | Detalle, búsqueda y exportar como JSON |
| `create_nodes` | Crear pantallas enteras (con hijos anidados) en una sola llamada |
| `update_nodes`, `delete_nodes`, `move_nodes`, `duplicate_nodes` | Editar en lote |
| `bulk_update` | Cambiar muchas capas por filtro (ej. todas las fuentes de un tipo) sin listar ids |
| `create_page` | Agregar páginas |
| `get_screenshot` | Captura PNG de una página o frame |

## Importante sobre el plan gratis de Render

- El servicio gratis se duerme a los 15 minutos sin uso y tarda cerca de un minuto en despertar. Si Claude dice que no puede conectarse, abrí la web primero y reintentá.
- Sin base de datos, los diseños se pierden cada vez que el servicio se reinicia. Por eso el `render.yaml` crea Postgres.
- La base Postgres gratis de Render vence al mes. Para algo permanente, creá una base gratis en [Neon](https://neon.tech) o Supabase y poné su cadena de conexión en `DATABASE_URL` (podés borrar la sección `databases` del `render.yaml`).

## Usarlo en tu computadora

```bash
npm install
npm start
```

Abrí http://localhost:3000. Sin `ACCESS_TOKEN` no pide clave y el MCP queda en `/mcp` (solo para uso local). Los diseños se guardan en la carpeta `data/`.

## Lo que todavía no tiene

Auto layout, componentes y variantes, herramienta pluma (vectores), prototipos e importar archivos `.fig`. La captura del MCP aproxima los gradientes a color sólido y usa una tipografía sans genérica; en el navegador se ve todo con la fuente real.
