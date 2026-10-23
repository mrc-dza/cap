// ==UserScript==
// @name         Inyector Maestro V32.3 (GitHub Auto-Fetch + GoJS + Omitir Iniciados)
// @namespace    http://tampermonkey.net/
// @version      32.3
// @description  Descarga desde GitHub (mrc-dza/cap) o local. Omite ejercicios ya iniciados y se limpia al Guardar.
// @author       Marcos
// @match        https://cursosabiertos.usfx.bo/materias/*/capitulos/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    if (!document.querySelector('.ejercicio')) return;

    // =========================================================================
    // CONFIGURACIÓN DEL REPOSITORIO GITHUB
    // =========================================================================
    const GITHUB_USER   = 'mrc-dza';
    const GITHUB_REPO   = 'cap';
    const GITHUB_BRANCH = 'main';

    const MAX_INTENTOS = 15;
    const VERIFICAR_DIAGRAMA = true;

    // =========================================================================
    // MÓDULO 1: AUTO-DESBLOQUEADOR Y LIMPIEZA AL GUARDAR
    // =========================================================================
    const ESPERA_MS = 300;
    const timers = new Map();

    function limpiarRastro() {
        document.removeEventListener('click', alHacerClic, true);
        document.removeEventListener('click', interceptarGuardar, true);
        timers.forEach(id => clearTimeout(id));
        timers.clear();
        document.querySelectorAll('.tm-inyectado').forEach(el => el.remove());
    }

    function interceptarGuardar(evento) {
        const btnGuardar = evento.target.closest && evento.target.closest('#btGuardar, button[onclick*="savePage"]');
        if (btnGuardar) {
            limpiarRastro();
        }
    }
    document.addEventListener('click', interceptarGuardar, true);

    if (typeof window.savePage === 'function' && !window.savePage._envuelto) {
        const saveOriginal = window.savePage;
        const reemplazo = function () {
            limpiarRastro();
            return saveOriginal.apply(this, arguments);
        };
        reemplazo._envuelto = true;
        window.savePage = reemplazo;
    }

    function alHacerClic(evento) {
        const boton = evento.target.closest && evento.target.closest('button');
        if (!boton) return;

        const onclick = boton.getAttribute('onclick') || '';
        const esGenerar = boton.classList.contains('btGenerar') || onclick.includes('generar');
        const esRepetir = boton.classList.contains('btRepetir') || onclick.includes('repetir');
        if (!esGenerar && !esRepetir) return;

        const ejercicio = boton.closest('.ejercicio');
        if (!ejercicio) return;

        clearTimeout(timers.get(ejercicio));

        const id = setTimeout(() => {
            timers.delete(ejercicio);
            const corregir = ejercicio.querySelector('#btCorregir, .btCorregir');
            if (corregir) {
                corregir.removeAttribute('disabled');
                corregir.disabled = false;
            }
        }, ESPERA_MS);

        timers.set(ejercicio, id);
    }
    document.addEventListener('click', alHacerClic, true);

    // =========================================================================
    // MÓDULO 2: DETECCIÓN DE MATERIA Y BUSCADOR EN GITHUB
    // =========================================================================
    function obtenerMetadatosCapitulo() {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        for (const s of scripts) {
            const m = s.src.match(/materias\/([a-zA-Z0-9_-]+)\/capitulos\/(capitulo\d+)/i);
            if (m) {
                return {
                    materia: m[1].toLowerCase(),
                    capitulo: m[2].toLowerCase(),
                    num: m[2].replace(/\D/g, '')
                };
            }
        }

        const mUrl = location.pathname.match(/materias\/([a-zA-Z0-9_-]+)\/capitulos\/(capitulo\d+)/i);
        if (mUrl) {
            return {
                materia: mUrl[1].toLowerCase(),
                capitulo: mUrl[2].toLowerCase(),
                num: mUrl[2].replace(/\D/g, '')
            };
        }
        return null;
    }

    async function descargarHTMLDesdeGitHub(meta) {
        const baseRaw = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${meta.materia}`;

        const candidatosDirectos = [
            `${baseRaw}/${meta.num}.html`,
            `${baseRaw}/${meta.capitulo}.html`
        ];

        for (const url of candidatosDirectos) {
            try {
                const r = await fetch(url, { cache: 'no-store' });
                if (r.ok) {
                    console.log('[Inyector V32] Descargado directo:', url);
                    return await r.text();
                }
            } catch (e) {}
        }

        const apiUrl = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${meta.materia}?ref=${GITHUB_BRANCH}`;
        const respApi = await fetch(apiUrl, { cache: 'no-store' });
        if (!respApi.ok) {
            throw new Error(`No se encontró la carpeta "${meta.materia}" en el repositorio (${respApi.status})`);
        }

        const archivos = await respApi.json();
        if (!Array.isArray(archivos)) {
            throw new Error('Respuesta inesperada al listar la carpeta en GitHub.');
        }

        const num = String(meta.num);
        const limpiar = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

        const coincidencias = [
            f => new RegExp(`^0*${num}\\.html?$`, 'i').test(f.name.trim()),
            f => new RegExp(`cap[ií]tulo[\\s_-]*0*${num}(?!\\d).*\\.html?$`, 'i').test(limpiar(f.name)),
            f => new RegExp(`(?:^|[^\\d])0*${num}\\.html?$`, 'i').test(f.name.trim())
        ];

        let archivoElegido = null;
        for (const regla of coincidencias) {
            archivoElegido = archivos.find(f => f.type === 'file' && regla(f));
            if (archivoElegido) break;
        }

        if (!archivoElegido) {
            throw new Error(`No hay archivo para el capítulo ${num} dentro de "${meta.materia}".`);
        }

        const urlFinal = archivoElegido.download_url || `${baseRaw}/${encodeURIComponent(archivoElegido.name)}`;
        console.log('[Inyector V32] Archivo encontrado por API:', archivoElegido.name);

        const respHtml = await fetch(urlFinal, { cache: 'no-store' });
        if (!respHtml.ok) {
            throw new Error(`Error al descargar "${archivoElegido.name}" (${respHtml.status})`);
        }
        return await respHtml.text();
    }

    // =========================================================================
    // MÓDULO 3: UTILIDADES
    // =========================================================================
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = 'tm-inyectado';
        const colors = { info: '#3b82f6', success: '#16a34a', error: '#ef4444', warning: '#f59e0b' };

        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%) translateY(100px)',
            background: colors[type] || colors.info, color: 'white', padding: '12px 24px', borderRadius: '8px',
            fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontWeight: '500',
            boxShadow: '0 4px 15px rgba(0,0,0,0.2)', zIndex: '10000', opacity: '0',
            transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
        });
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.transform = 'translateX(-50%) translateY(0)';
            toast.style.opacity = '1';
        });
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(20px)';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    function extraerNumCapTitulo(titulo) {
        const m = (titulo || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/capitulo\s*(\d+)/i);
        return m ? m[1] : null;
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function esperarHasta(cond, max = 2000, paso = 40) {
        const fin = Date.now() + max;
        while (Date.now() < fin) {
            try { if (cond()) return true; } catch (e) {}
            await sleep(paso);
        }
        return false;
    }

    const SEL_CAMPOS = '.campo_literal, .campo_arrastrar, .campo_dato';
    const SEL_TODO   = SEL_CAMPOS + ', p.opcionMultiple';
    const norm = t => (t || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
    const esVisible = el => !!(el.offsetParent || el.getClientRects().length);

    function textoInst(el) {
        const d = document.createElement('div');
        d.innerHTML = el.innerHTML
            .replace(/<br\s*[\/]?>/gi, '\n')
            .replace(/<\/p>|<\/div>/gi, '\n');
        return d.textContent.replace(/\u200B/g, '').replace(/^\n+|\n+$/g, '');
    }

    function firmaCampos(ej) {
        const partes = Array.from(ej.querySelectorAll('p.pregunta, div.dato tr, p.opcionMultiple'))
            .filter(n => n.matches('p.opcionMultiple') || n.querySelector(SEL_CAMPOS))
            .map(n => {
                const c = n.cloneNode(true);
                c.querySelectorAll(SEL_CAMPOS).forEach(sp => {
                    const ops = (sp.getAttribute('data-opciones') || '')
                        .split('&@%').map(norm).sort().join('|');
                    sp.replaceWith('§' + (ops ? '{' + ops + '}' : ''));
                });
                return norm(c.textContent);
            });
        return partes.sort().join('||');
    }

    const KB_KEY = 'tm_kb_opciones_' + location.pathname;
    const conocimiento = new Map();
    try { JSON.parse(localStorage.getItem(KB_KEY) || '[]').forEach(([k, v]) => conocimiento.set(k, v)); } catch (e) {}
    const guardarKB = () => { try { localStorage.setItem(KB_KEY, JSON.stringify([...conocimiento])); } catch (e) {} };
    const textoOpcion = p => norm((p.querySelector('label') || {}).textContent);

    function llenarOpciones(ej) {
        ej.querySelectorAll('p.opcionMultiple').forEach(p => {
            const inp = p.querySelector('input');
            if (!inp) return;
            const quiere = conocimiento.get(textoOpcion(p)) === true;
            if (inp.checked !== quiere) inp.click();
        });
    }

    function aprenderOpciones(ej, enviado) {
        const ps = Array.from(ej.querySelectorAll('p.opcionMultiple'));
        const marcadas = ps.filter(p => p.classList.contains('correcta')).length;
        if (ps.length === 0 || marcadas === 0) return 0;
        let nuevos = 0;
        ps.forEach(p => {
            const t = textoOpcion(p);
            const estado = enviado.get(t);
            const verdad = p.classList.contains('correcta') ? estado : !estado;
            if (conocimiento.get(t) !== verdad) { conocimiento.set(t, verdad); nuevos++; }
        });
        guardarKB();
        return nuevos;
    }

    async function elegirOpcion(campo, respuesta) {
        const buscar = () => Array.from(document.body.querySelectorAll('*')).filter(el =>
            el !== campo && !campo.contains(el) &&
            !el.closest('.CodeMirror') && !el.closest('.tm-inyectado') &&
            norm(el.textContent) === respuesta && esVisible(el) &&
            !Array.from(el.children).some(h => norm(h.textContent) === respuesta));

        const antes = new Set(buscar());
        campo.scrollIntoView({ block: 'center' });
        campo.click();
        await esperarHasta(() => buscar().some(el => !antes.has(el)), 1500);

        const nuevas = buscar().filter(el => !antes.has(el));
        if (nuevas.length) {
            const op = nuevas[0];
            ['mousedown', 'mouseup', 'click'].forEach(t =>
                op.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
            await esperarHasta(() => norm(campo.textContent) === respuesta, 800);
        }

        if (norm(campo.textContent) !== respuesta) {
            console.warn('Menú no respondió; se escribe el texto directo:', respuesta);
            campo.textContent = respuesta;
            campo.dispatchEvent(new Event('input', { bubbles: true }));
            campo.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    async function escribirCelda(liveCalc, indice, texto) {
        if (!texto) return;
        let liveCM = liveCalc.querySelectorAll('.CodeMirror')[indice];
        if (!liveCM) {
            await esperarHasta(() => liveCalc.querySelectorAll('.CodeMirror')[indice], 2000);
            liveCM = liveCalc.querySelectorAll('.CodeMirror')[indice];
        }
        if (liveCM && liveCM.CodeMirror) {
            const cm = liveCM.CodeMirror;
            cm.setValue(texto);
            cm.focus();
            cm.setCursor(cm.lineCount(), 0);
            cm.getInputField().dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                shiftKey: true, bubbles: true, cancelable: true
            }));
            await sleep(120);
        }
    }

    // =========================================================================
    // MÓDULO 4: DIAGRAMAS GOJS
    // =========================================================================
    function limpiarComodines(t) {
        if (typeof t !== 'string' || !t.includes('_(')) return t;
        return t
            .replace(/_\(([\s\S]*?)_\)/g, (m, inner) => inner.split('_|')[0].replace(/_/g, ''))
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
    }

    function extraerModeloGoJS(texto) {
        if (!texto) return null;
        const ini = texto.lastIndexOf('{"class":"go.GraphLinksModel"');
        if (ini === -1) return null;
        let prof = 0, enCadena = false, escape = false;
        for (let i = ini; i < texto.length; i++) {
            const ch = texto[i];
            if (enCadena) {
                if (escape) escape = false;
                else if (ch === '\\') escape = true;
                else if (ch === '"') enCadena = false;
                continue;
            }
            if (ch === '"') { enCadena = true; continue; }
            if (ch === '{') prof++;
            else if (ch === '}') {
                prof--;
                if (prof === 0) {
                    try { return JSON.parse(texto.slice(ini, i + 1)); } catch (e) { return null; }
                }
            }
        }
        return null;
    }

    const esDiagramaSrc  = c => /gojsGraph\s*\(/.test(c.textContent);
    const esDiagramaVivo = c => !!c.querySelector('canvas') || /gojsGraph\s*\(/.test(c.textContent);

    function diagramaDe(calc) {
        const cv = calc.querySelector('canvas');
        if (!cv || !window.go || !window.go.Diagram) return null;
        for (let el = cv; el; el = el.parentElement) {
            const d = window.go.Diagram.fromDiv(el);
            if (d) return d;
        }
        return null;
    }

    function correctoEn(calc) {
        const c = calc.cloneNode(true);
        c.querySelectorAll('.CodeMirror, .instruccion, textarea, canvas, svg').forEach(e => e.remove());
        const t = norm(c.textContent).toLowerCase();
        return /correcto/.test(t) && !/incorrecto/.test(t);
    }

    function shiftEnterEn(el) {
        if (!el) return;
        if (el.focus) el.focus();
        ['keydown', 'keyup'].forEach(tipo =>
            el.dispatchEvent(new KeyboardEvent(tipo, {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                shiftKey: true, bubbles: true, cancelable: true
            })));
    }

    function inyectarModelo(d, modelo) {
        const m = d.model;
        d.startTransaction('InyeccionModelo');
        try {
            const enlacesViejos = [...m.linkDataArray];
            if (m.removeLinkDataCollection) m.removeLinkDataCollection(enlacesViejos);
            else enlacesViejos.forEach(l => m.removeLinkData(l));

            (modelo.nodeDataArray || []).forEach(src => {
                const texto = limpiarComodines(src.text);
                const nodo = m.findNodeDataForKey(src.key);
                if (nodo) {
                    if (src.text !== undefined) m.setDataProperty(nodo, 'text', texto);
                } else {
                    const copia = JSON.parse(JSON.stringify(src));
                    copia.text = texto;
                    m.addNodeData(copia);
                }
            });

            (modelo.linkDataArray || []).forEach(l => {
                const copia = JSON.parse(JSON.stringify(l));
                if (typeof copia.text === 'string') copia.text = limpiarComodines(copia.text);
                m.addLinkData(copia);
            });

            d.commitTransaction('InyeccionModelo');
            return true;
        } catch (e) {
            console.error('Error inyectando el modelo GoJS:', e);
            try { d.rollbackTransaction(); } catch (e2) {}
            return false;
        }
    }

    async function procesarDiagrama(liveCalc, srcCalc, id, intento) {
        const modelo = extraerModeloGoJS(srcCalc.textContent) || extraerModeloGoJS(liveCalc.textContent);
        if (!modelo) return null;

        await esperarHasta(() => diagramaDe(liveCalc), 2500);
        const d = diagramaDe(liveCalc);

        if (d && inyectarModelo(d, modelo)) {
            await sleep(60);
            shiftEnterEn(liveCalc.querySelector('canvas'));
        } else {
            console.warn(`[${id}] sin diagrama GoJS accesible; se usa la celda de código.`);
            const textos = Array.from(srcCalc.querySelectorAll('.instruccion'))
                .map(textoInst).map(limpiarComodines);
            for (let k = 0; k < textos.length; k++) await escribirCelda(liveCalc, k, textos[k]);
        }

        if (!VERIFICAR_DIAGRAMA) return true;

        let ok = await esperarHasta(() => correctoEn(liveCalc), 2500, 100);
        if (!ok) {
            const cv = liveCalc.querySelector('canvas');
            shiftEnterEn(cv);
            if (cv && cv.parentElement) shiftEnterEn(cv.parentElement);
            ok = await esperarHasta(() => correctoEn(liveCalc), 3000, 100);
        }
        return ok;
    }

    // =========================================================================
    // MÓDULO 5: INTERFAZ GRÁFICA
    // =========================================================================
    const metaActual = obtenerMetadatosCapitulo();
    const etiquetaCap = metaActual ? `${metaActual.materia.toUpperCase()} - Cap ${metaActual.num}` : 'V32';

    const contenedorBotones = document.createElement('div');
    contenedorBotones.className = 'tm-inyectado';
    Object.assign(contenedorBotones.style, {
        position: 'fixed', bottom: '30px', right: '30px', zIndex: '9999', display: 'flex', gap: '8px', alignItems: 'center'
    });

    const btnGitHub = document.createElement('button');
    const iconoDescarga = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    const TEXTO_BTN = `${iconoDescarga}Inyectar (${etiquetaCap})`;
    btnGitHub.innerHTML = TEXTO_BTN;
    Object.assign(btnGitHub.style, {
        display: 'flex', alignItems: 'center', padding: '10px 18px', background: '#2563eb', color: '#ffffff',
        border: 'none', borderRadius: '50px', cursor: 'pointer', fontSize: '13px', fontWeight: '600',
        fontFamily: 'system-ui, sans-serif', boxShadow: '0 4px 14px rgba(37, 99, 235, 0.4)', transition: 'all 0.2s ease'
    });

    const btnLocal = document.createElement('button');
    btnLocal.textContent = 'Local';
    btnLocal.title = 'Cargar archivo HTML manualmente desde tu PC';
    Object.assign(btnLocal.style, {
        padding: '10px 14px', background: '#334155', color: 'white', border: 'none',
        borderRadius: '50px', cursor: 'pointer', fontSize: '12px', fontWeight: '600',
        fontFamily: 'system-ui, sans-serif', boxShadow: '0 4px 10px rgba(0,0,0,0.2)'
    });

    const btnCerrar = document.createElement('button');
    btnCerrar.textContent = 'X';
    btnCerrar.title = 'Eliminar inyector de la página';
    Object.assign(btnCerrar.style, {
        width: '34px', height: '34px', background: '#64748b', color: 'white', border: 'none',
        borderRadius: '50%', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold',
        fontFamily: 'system-ui, sans-serif'
    });
    btnCerrar.addEventListener('click', limpiarRastro);

    contenedorBotones.appendChild(btnGitHub);
    contenedorBotones.appendChild(btnLocal);
    contenedorBotones.appendChild(btnCerrar);
    document.body.appendChild(contenedorBotones);

    const inputFile = document.createElement('input');
    inputFile.className = 'tm-inyectado';
    inputFile.type = 'file';
    inputFile.accept = '.html,.htm';
    inputFile.style.display = 'none';
    document.body.appendChild(inputFile);

    function resetearBtn() {
        btnGitHub.disabled = false;
        btnLocal.disabled = false;
        btnGitHub.innerHTML = TEXTO_BTN;
        btnGitHub.style.opacity = '1';
        btnGitHub.style.cursor = 'pointer';
    }

    // =========================================================================
    // MÓDULO 6: MOTOR CENTRAL DE INYECCIÓN
    // =========================================================================
    async function ejecutarInyeccionConHTML(htmlTexto) {
        let doc;
        try {
            doc = new DOMParser().parseFromString(htmlTexto, 'text/html');
        } catch (err) {
            showToast('Error: HTML inválido.', 'error');
            resetearBtn();
            return;
        }

        const capDoc = extraerNumCapTitulo(doc.title);
        const capPag = extraerNumCapTitulo(document.title) || (metaActual && metaActual.num);
        if (capDoc && capPag && capDoc !== String(capPag)) {
            showToast(`Error: El archivo es del capítulo ${capDoc}, pero estás en el capítulo ${capPag}.`, 'error');
            resetearBtn();
            return;
        }

        doc.querySelectorAll('p.opcionMultiple').forEach(p => {
            const inp = p.querySelector('input');
            if (inp) conocimiento.set(textoOpcion(p), inp.hasAttribute('checked') || inp.checked);
        });
        guardarKB();

        const liveEjercicios = Array.from(document.querySelectorAll('div.ejercicio[id]'));
        let reemplazados = 0;
        let omitidos = 0;

        for (let i = 0; i < liveEjercicios.length; i++) {
            const ejActual = liveEjercicios[i];
            const id = ejActual.id;
            if (!id) continue;

            // -----------------------------------------------------------------
            // RESTRICCIÓN AL INICIO: Si ya tiene btRepetir (o no tiene btGenerar), se salta
            // -----------------------------------------------------------------
            const btnGenInicial = ejActual.querySelector('.btGenerar');
            const btnRepInicial = ejActual.querySelector('.btRepetir');
            const tieneRepetirActivo = btnRepInicial && esVisible(btnRepInicial);
            const tieneGenerarActivo = btnGenInicial && esVisible(btnGenInicial);

            if (tieneRepetirActivo || !tieneGenerarActivo) {
                console.log(`[${id}] Ejercicio ya iniciado (btRepetir presente). Se omite.`);
                omitidos++;
                continue;
            }

            btnGitHub.innerHTML = `${iconoDescarga}Procesando ${i + 1}/${liveEjercicios.length}...`;

            let resueltoConExito = false;

            for (let intento = 0; intento < MAX_INTENTOS; intento++) {
                const botonAccion = (intento === 0) ? ejActual.querySelector('.btGenerar') : ejActual.querySelector('.btRepetir');
                if (botonAccion) {
                    const antesHTML = ejActual.innerHTML;
                    botonAccion.click();
                    await esperarHasta(() => ejActual.innerHTML !== antesHTML, 2500);
                    await sleep(150);
                }

                const numEnunciado = ejActual.getAttribute('enunciado');
                let ejResuelto = doc.querySelector(`div.ejercicio[id="${id}"][enunciado="${numEnunciado}"]`);

                const tieneCampos = ejActual.querySelector(SEL_TODO) !== null;
                const soloOpciones = ejActual.querySelector('p.opcionMultiple') !== null && !ejActual.querySelector(SEL_CAMPOS);
                if (soloOpciones) {
                    const todasConocidas = Array.from(ejActual.querySelectorAll('p.opcionMultiple'))
                        .every(p => conocimiento.has(textoOpcion(p)));
                    if (!todasConocidas) ejResuelto = null;
                } else if (ejResuelto && tieneCampos && firmaCampos(ejResuelto) !== firmaCampos(ejActual)) {
                    if (intento === MAX_INTENTOS - 1) {
                        console.warn(`[${id}] firma NO coincide.\nPÁGINA: ${firmaCampos(ejActual)}\nARCHIVO: ${firmaCampos(ejResuelto)}`);
                    }
                    ejResuelto = null;
                }

                const btnCorregir = ejActual.querySelector('.btCorregir, #btCorregir');

                if (ejResuelto) {
                    // A) CALCULADORAS: diagramas y celdas de código
                    const liveCalculadoras = Array.from(ejActual.querySelectorAll('.calculadora'));
                    const sourceCalculadoras = Array.from(ejResuelto.querySelectorAll('.calculadora'));

                    const srcDiag   = sourceCalculadoras.filter(esDiagramaSrc);
                    const srcNoDiag = sourceCalculadoras.filter(c => !esDiagramaSrc(c));
                    const liveNoDiag = liveCalculadoras.filter(c => !esDiagramaVivo(c));

                    const planPorCalc = new Map();
                    if (liveNoDiag.length === srcNoDiag.length) {
                        liveNoDiag.forEach((c, j) =>
                            planPorCalc.set(c, Array.from(srcNoDiag[j].querySelectorAll('.instruccion')).map(textoInst)));
                    } else {
                        const todas = srcNoDiag
                            .flatMap(c => Array.from(c.querySelectorAll('.instruccion')).map(textoInst))
                            .filter(t => t);
                        const cupo = liveNoDiag.map(c => Math.max(1,
                            Array.from(c.querySelectorAll('.CodeMirror'))
                                .filter(cm => cm.CodeMirror && cm.CodeMirror.getValue().trim() !== '').length));
                        liveNoDiag.forEach((c, j) =>
                            planPorCalc.set(c, j === liveNoDiag.length - 1 ? todas.splice(0) : todas.splice(0, cupo[j])));
                    }

                    let diagramaFallo = false;
                    let idxDiag = 0;
                    for (const liveCalc of liveCalculadoras) {
                        if (esDiagramaVivo(liveCalc)) {
                            const srcCalc = srcDiag[idxDiag++];
                            if (!srcCalc) continue;
                            const res = await procesarDiagrama(liveCalc, srcCalc, id, intento);
                            if (res === false) diagramaFallo = true;
                        } else {
                            const textos = planPorCalc.get(liveCalc) || [];
                            for (let k = 0; k < textos.length; k++) {
                                await escribirCelda(liveCalc, k, textos[k]);
                            }
                        }
                    }

                    if (diagramaFallo && intento < MAX_INTENTOS - 1) {
                        if (btnCorregir) {
                            btnCorregir.removeAttribute('disabled');
                            btnCorregir.disabled = false;
                            btnCorregir.click();
                            await sleep(700);
                        }
                        continue;
                    }

                    // B) CAMPOS (literal, arrastrar, dato, opción múltiple)
                    if (tieneCampos) {
                        const srcLit = ejResuelto.querySelectorAll('.campo_literal');
                        const liveLit = ejActual.querySelectorAll('.campo_literal');
                        for (let k = 0; k < liveLit.length; k++) {
                            if (!srcLit[k]) continue;
                            const campo = liveLit[k];
                            campo.textContent = norm(srcLit[k].textContent);
                            campo.dispatchEvent(new Event('input', { bubbles: true }));
                            campo.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                            campo.dispatchEvent(new Event('blur', { bubbles: true }));
                            await sleep(20);
                        }

                        const SEL_SEL = '.campo_arrastrar, .campo_dato';
                        const srcSel = Array.from(ejResuelto.querySelectorAll(SEL_SEL));
                        const liveSel = Array.from(ejActual.querySelectorAll(SEL_SEL));
                        const claveFila = c => {
                            const td = c.closest('tr') && c.closest('tr').firstElementChild;
                            return td && !td.contains(c) ? norm(td.textContent) : null;
                        };
                        for (let k = 0; k < liveSel.length; k++) {
                            const clave = claveFila(liveSel[k]);
                            let origen = clave ? srcSel.find(c => claveFila(c) === clave) : null;
                            if (!origen) origen = srcSel[k];
                            if (!origen) continue;
                            await elegirOpcion(liveSel[k], norm(origen.textContent));
                        }

                        ejActual.querySelectorAll('p.opcionMultiple').forEach(p => {
                            const inp = p.querySelector('input');
                            const quiere = conocimiento.get(textoOpcion(p));
                            if (inp && quiere !== undefined && inp.checked !== quiere) inp.click();
                        });
                    }

                    // C) INPUTS DE TEXTO REGULARES
                    const sourceInputs = ejResuelto.querySelectorAll('input[type="text"]:not(.notas):not(.ittiempo)');
                    const liveInputs = ejActual.querySelectorAll('input[type="text"]:not(.notas):not(.ittiempo)');
                    liveInputs.forEach((input, index) => {
                        if (sourceInputs[index]) {
                            input.value = sourceInputs[index].value || sourceInputs[index].getAttribute('value') || '';
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    });

                    await sleep(100);

                    // D) CORREGIR
                    if (btnCorregir) {
                        btnCorregir.removeAttribute('disabled');
                        btnCorregir.disabled = false;
                        btnCorregir.click();
                        await sleep(700);
                    }

                    resueltoConExito = true;
                    reemplazados++;
                    break;

                } else {
                    let enviado = null;
                    if (soloOpciones) {
                        llenarOpciones(ejActual);
                        enviado = new Map(Array.from(ejActual.querySelectorAll('p.opcionMultiple'))
                            .map(p => [textoOpcion(p), p.querySelector('input').checked]));
                    }
                    if (btnCorregir) {
                        btnCorregir.removeAttribute('disabled');
                        btnCorregir.disabled = false;
                        btnCorregir.click();
                        await sleep(700);
                    }
                    if (enviado) {
                        aprenderOpciones(ejActual, enviado);
                    }
                }
            }
        }

        if (reemplazados === 0 && omitidos > 0) {
            showToast(`No se inyectó nada: ${omitidos} ejercicios ya estaban iniciados.`, 'info');
            resetearBtn();
            return;
        }

        if (reemplazados === 0) {
            showToast('No se pudo emparejar ningún ejercicio con el archivo.', 'warning');
            resetearBtn();
            return;
        }

        const msgOmitidos = omitidos > 0 ? ` (${omitidos} omitidos por estar iniciados)` : '';
        showToast(`Flujo completado: ${reemplazados} ejercicios procesados${msgOmitidos}.`, 'success');
        resetearBtn();
    }

    // Accion 1: Descarga bajo demanda desde GitHub
    btnGitHub.addEventListener('click', async () => {
        if (btnGitHub.disabled) return;

        const meta = obtenerMetadatosCapitulo();
        if (!meta) {
            showToast('No se pudo detectar la materia ni el capítulo en la página.', 'error');
            return;
        }

        btnGitHub.disabled = true;
        btnLocal.disabled = true;
        btnGitHub.innerHTML = `${iconoDescarga}Buscando en GitHub...`;
        btnGitHub.style.opacity = '0.7';

        try {
            const html = await descargarHTMLDesdeGitHub(meta);
            await ejecutarInyeccionConHTML(html);
        } catch (err) {
            console.error('[Inyector V32]', err);
            showToast(err.message || 'Error al conectar con GitHub.', 'error');
            resetearBtn();
        }
    });

    // Accion 2: Carga manual desde PC
    btnLocal.addEventListener('click', () => {
        if (!btnLocal.disabled) inputFile.click();
    });

    inputFile.addEventListener('change', () => {
        const file = inputFile.files[0];
        if (!file) return;

        btnGitHub.disabled = true;
        btnLocal.disabled = true;
        btnGitHub.innerHTML = `${iconoDescarga}Leyendo archivo...`;
        btnGitHub.style.opacity = '0.7';

        const reader = new FileReader();
        reader.onload = async (e) => {
            inputFile.value = '';
            await ejecutarInyeccionConHTML(e.target.result);
        };
        reader.readAsText(file);
    });
})();
