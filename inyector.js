// ==UserScript==
// @name         Inyector Maestro V32.10 (Filtro por Nota < 100 en Iniciados)
// @namespace    http://tampermonkey.net/
// @version      32.10
// @description  Descarga desde GitHub (mrc-dza/cap) o local. Panel rectangular, botón pildorita, y en modo "iniciados" solo reinyecta si la nota es menor a 100.
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

    let cancelado = false;
    let cacheHTMLGitHub = null;

    // =========================================================================
    // ESCUDO ANTI-ROBO DE FOCO Y SCROLL
    // =========================================================================
    const focusOriginal = HTMLElement.prototype.focus;
    const scrollOriginal = Element.prototype.scrollIntoView;
    const windowScrollTo = window.scrollTo;
    let bloqueoFocoActivo = false;

    function activarEscudoFoco() {
        if (bloqueoFocoActivo) return;
        bloqueoFocoActivo = true;
        const posX = window.scrollX;
        const posY = window.scrollY;

        HTMLElement.prototype.focus = function () {};
        Element.prototype.scrollIntoView = function () {};
        window.scrollTo = function () {
            return windowScrollTo.call(window, posX, posY);
        };
    }

    function desactivarEscudoFoco() {
        if (!bloqueoFocoActivo) return;
        bloqueoFocoActivo = false;
        HTMLElement.prototype.focus = focusOriginal;
        Element.prototype.scrollIntoView = scrollOriginal;
        window.scrollTo = windowScrollTo;
    }

    // =========================================================================
    // MÓDULO 1: AUTO-DESBLOQUEADOR Y LIMPIEZA AL GUARDAR
    // =========================================================================
    const ESPERA_MS = 300;
    const timers = new Map();
    const KB_KEY = 'tm_kb_opciones_' + location.pathname;

    function limpiarRastro() {
        cancelado = true;
        desactivarEscudoFoco();
        document.removeEventListener('click', alHacerClic, true);
        document.removeEventListener('click', interceptarGuardar, true);
        timers.forEach(id => clearTimeout(id));
        timers.clear();
        try { localStorage.removeItem(KB_KEY); } catch (e) {}
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
        for (const s of document.querySelectorAll('script[src]')) {
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
        if (cacheHTMLGitHub) return cacheHTMLGitHub;

        const baseRaw = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${meta.materia}`;
        const num = String(meta.num);
        const numPad = num.padStart(2, '0');

        const candidatosDirectos = [
            `${baseRaw}/${num}.html`,
            `${baseRaw}/${meta.capitulo}.html`,
            `${baseRaw}/${numPad}.html`
        ];

        for (const url of candidatosDirectos) {
            try {
                const r = await fetch(url, { cache: 'no-store' });
                if (r.ok) {
                    cacheHTMLGitHub = await r.text();
                    return cacheHTMLGitHub;
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
        const respHtml = await fetch(urlFinal, { cache: 'no-store' });
        if (!respHtml.ok) {
            throw new Error(`Error al descargar "${archivoElegido.name}" (${respHtml.status})`);
        }

        cacheHTMLGitHub = await respHtml.text();
        return cacheHTMLGitHub;
    }

    // =========================================================================
    // MÓDULO 3: UTILIDADES
    // =========================================================================
    function showToast(message, type = 'info') {
        if (cancelado) return;
        const toast = document.createElement('div');
        toast.className = 'tm-inyectado';
        const colors = { info: '#3b82f6', success: '#16a34a', error: '#ef4444', warning: '#f59e0b' };

        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%) translateY(100px)',
            background: colors[type] || colors.info, color: 'white', padding: '12px 24px', borderRadius: '0px',
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
            if (cancelado) return false;
            try { if (cond()) return true; } catch (e) {}
            await sleep(paso);
        }
        return false;
    }

    const SEL_CAMPOS = '.campo_literal, .campo_arrastrar, .campo_dato';
    const SEL_TODO   = SEL_CAMPOS + ', p.opcionMultiple';
    const norm = t => (t || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
    const esVisible = el => !!(el && (el.offsetParent || el.getClientRects().length));

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

    const conocimiento = new Map();
    try { JSON.parse(localStorage.getItem(KB_KEY) || '[]').forEach(([k, v]) => conocimiento.set(k, v)); } catch (e) {}
    const guardarKB = () => { if (!cancelado) { try { localStorage.setItem(KB_KEY, JSON.stringify([...conocimiento])); } catch (e) {} } };
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
        const SEL_POPUP = 'div, li, span, a, p, td';
        const buscar = () => Array.from(document.body.querySelectorAll(SEL_POPUP)).filter(el =>
            el !== campo && !campo.contains(el) &&
            !el.closest('.CodeMirror') && !el.closest('.tm-inyectado') &&
            norm(el.textContent) === respuesta && esVisible(el) &&
            !Array.from(el.children).some(h => norm(h.textContent) === respuesta));

        const antes = new Set(buscar());
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
            campo.textContent = respuesta;
            campo.dispatchEvent(new Event('input', { bubbles: true }));
            campo.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    async function escribirCelda(liveCalc, indice, texto) {
        if (!texto || cancelado) return;
        let liveCM = liveCalc.querySelectorAll('.CodeMirror')[indice];
        if (!liveCM) {
            await esperarHasta(() => liveCalc.querySelectorAll('.CodeMirror')[indice], 2000);
            liveCM = liveCalc.querySelectorAll('.CodeMirror')[indice];
        }
        if (liveCM && liveCM.CodeMirror) {
            const cm = liveCM.CodeMirror;
            cm.setValue(texto);
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
            try { d.rollbackTransaction(); } catch (e2) {}
            return false;
        }
    }

    async function procesarDiagrama(liveCalc, srcCalc) {
        const modelo = extraerModeloGoJS(srcCalc.textContent) || extraerModeloGoJS(liveCalc.textContent);
        if (!modelo) return null;

        await esperarHasta(() => diagramaDe(liveCalc), 2500);
        const d = diagramaDe(liveCalc);

        if (d && inyectarModelo(d, modelo)) {
            await sleep(60);
            shiftEnterEn(liveCalc.querySelector('canvas'));
        } else {
            const textos = Array.from(srcCalc.querySelectorAll('.instruccion'))
                .map(textoInst).map(limpiarComodines);
            for (let k = 0; k < textos.length; k++) await escribirCelda(liveCalc, k, textos[k]);
        }

        if (!VERIFICAR_DIAGRAMA) return true;

        let ok = await esperarHasta(() => correctoEn(liveCalc), 2500, 100);
        if (!ok && !cancelado) {
            const cv = liveCalc.querySelector('canvas');
            shiftEnterEn(cv);
            if (cv && cv.parentElement) shiftEnterEn(cv.parentElement);
            ok = await esperarHasta(() => correctoEn(liveCalc), 3000, 100);
        }
        return ok;
    }

    // =========================================================================
    // MÓDULO 5: INTERFAZ GRÁFICA (PANEL RECTANGULAR + BOTÓN PILDORITA)
    // =========================================================================
    const metaActual = obtenerMetadatosCapitulo();
    const etiquetaCap = metaActual ? `${metaActual.materia.toUpperCase()} · Cap ${metaActual.num}` : 'V32.10';

    const contenedorRaiz = document.createElement('div');
    contenedorRaiz.className = 'tm-inyectado';
    Object.assign(contenedorRaiz.style, {
        position: 'fixed', bottom: '28px', right: '0', zIndex: '9999',
        display: 'flex', alignItems: 'center', fontFamily: 'system-ui, sans-serif'
    });

    const panelMenu = document.createElement('div');
    Object.assign(panelMenu.style, {
        display: 'none', flexDirection: 'column', gap: '8px',
        background: 'rgba(15, 23, 42, 0.95)', backdropFilter: 'blur(6px)',
        padding: '10px 12px', borderRadius: '0px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.15)',
        borderRight: 'none', marginRight: '0'
    });

    const seccionInfo = document.createElement('div');
    seccionInfo.textContent = etiquetaCap;
    Object.assign(seccionInfo.style, {
        background: '#1e293b', color: '#38bdf8', padding: '5px 8px',
        fontSize: '11px', fontWeight: '700', textAlign: 'center',
        border: '1px solid #334155', borderRadius: '0px', letterSpacing: '0.5px'
    });

    const filaControles = document.createElement('div');
    Object.assign(filaControles.style, {
        display: 'flex', alignItems: 'center', gap: '6px'
    });

    const selectModo = document.createElement('select');
    selectModo.title = 'Modo de inyección';
    Object.assign(selectModo.style, {
        padding: '6px 8px', background: '#1e293b', color: '#e2e8f0',
        border: '1px solid #475569', borderRadius: '0px', fontSize: '11px',
        fontWeight: '500', cursor: 'pointer', outline: 'none'
    });

    const optNoIniciados = document.createElement('option');
    optNoIniciados.value = 'no_iniciados';
    optNoIniciados.textContent = 'Solo no iniciados';

    const optIniciados = document.createElement('option');
    optIniciados.value = 'iniciados';
    optIniciados.textContent = 'Solo iniciados (<100)';

    const optTodos = document.createElement('option');
    optTodos.value = 'todos';
    optTodos.textContent = 'Todos';

    selectModo.appendChild(optNoIniciados);
    selectModo.appendChild(optIniciados);
    selectModo.appendChild(optTodos);

    const btnGitHub = document.createElement('button');
    const iconoDescarga = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    btnGitHub.innerHTML = iconoDescarga;
    btnGitHub.title = `Inyectar capítulo (${etiquetaCap})`;
    Object.assign(btnGitHub.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '32px', height: '32px', background: '#2563eb', color: '#ffffff',
        border: 'none', borderRadius: '50%', cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(37, 99, 235, 0.4)', transition: 'all 0.2s ease', padding: '0'
    });

    const btnLocal = document.createElement('button');
    btnLocal.textContent = 'Local';
    btnLocal.title = 'Cargar archivo HTML desde PC';
    Object.assign(btnLocal.style, {
        padding: '6px 10px', background: '#334155', color: 'white', border: 'none',
        borderRadius: '0px', cursor: 'pointer', fontSize: '11px', fontWeight: '600'
    });

    const btnCerrar = document.createElement('button');
    btnCerrar.textContent = '✕';
    btnCerrar.title = 'Cerrar inyector';
    Object.assign(btnCerrar.style, {
        width: '26px', height: '26px', background: '#ef4444', color: 'white', border: 'none',
        borderRadius: '0px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
    });
    btnCerrar.addEventListener('click', limpiarRastro);

    const btnPestana = document.createElement('button');
    btnPestana.textContent = '‹';
    btnPestana.title = 'Mostrar / ocultar panel';
    Object.assign(btnPestana.style, {
        width: '16px', height: '36px', background: '#0f172a', color: '#ffffff',
        border: '1px solid rgba(255,255,255,0.2)', borderRight: 'none',
        borderRadius: '0px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: '0.1', transition: 'opacity 0.2s ease, background 0.2s ease',
        padding: '0', userSelect: 'none'
    });

    let menuAbierto = false;
    btnPestana.addEventListener('mouseenter', () => { btnPestana.style.opacity = '0.85'; });
    btnPestana.addEventListener('mouseleave', () => { btnPestana.style.opacity = menuAbierto ? '0.75' : '0.22'; });

    btnPestana.addEventListener('click', () => {
        menuAbierto = !menuAbierto;
        panelMenu.style.display = menuAbierto ? 'flex' : 'none';
        btnPestana.textContent = menuAbierto ? '›' : '‹';
        btnPestana.style.opacity = menuAbierto ? '0.75' : '0.22';
    });

    filaControles.appendChild(selectModo);
    filaControles.appendChild(btnGitHub);
    filaControles.appendChild(btnLocal);
    filaControles.appendChild(btnCerrar);

    panelMenu.appendChild(seccionInfo);
    panelMenu.appendChild(filaControles);

    contenedorRaiz.appendChild(panelMenu);
    contenedorRaiz.appendChild(btnPestana);
    document.body.appendChild(contenedorRaiz);

    const inputFile = document.createElement('input');
    inputFile.className = 'tm-inyectado';
    inputFile.type = 'file';
    inputFile.accept = '.html,.htm';
    inputFile.style.display = 'none';
    document.body.appendChild(inputFile);

    function resetearBtn() {
        desactivarEscudoFoco();
        if (cancelado) return;
        btnGitHub.disabled = false;
        btnLocal.disabled = false;
        selectModo.disabled = false;
        btnGitHub.innerHTML = iconoDescarga;
        btnGitHub.style.opacity = '1';
        btnGitHub.style.cursor = 'pointer';
    }

    // =========================================================================
    // MÓDULO 6: MOTOR CENTRAL DE INYECCIÓN CON FILTRO DE NOTA < 100
    // =========================================================================
    async function ejecutarInyeccionConHTML(htmlTexto) {
        activarEscudoFoco();

        const modo = selectModo.value;

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
            if (cancelado) return;

            const ejActual = liveEjercicios[i];
            const id = ejActual.id;
            if (!id) continue;

            const btnGenInicial = ejActual.querySelector('.btGenerar');
            const btnRepInicial = ejActual.querySelector('.btRepetir');
            const tieneRepetirActivo = !!(btnRepInicial && esVisible(btnRepInicial));
            const tieneGenerarActivo = !!(btnGenInicial && esVisible(btnGenInicial));

            // Leer nota actual del ejercicio si la tuviera registrada
            const inputNota = ejActual.querySelector('input.notas');
            const notaActual = inputNota ? parseFloat(inputNota.value || inputNota.getAttribute('value') || '0') : 0;

            // Filtrado según el modo seleccionado
            if (modo === 'no_iniciados') {
                if (tieneRepetirActivo || !tieneGenerarActivo) {
                    omitidos++;
                    continue;
                }
            } else if (modo === 'iniciados') {
                // Solo iniciados: debe tener botón repetir activo Y su nota debe ser menor a 100
                if (!tieneRepetirActivo || notaActual >= 100) {
                    omitidos++;
                    continue;
                }
            } else {
                // Todos
                if (!tieneGenerarActivo && !tieneRepetirActivo) {
                    omitidos++;
                    continue;
                }
            }

            btnGitHub.innerHTML = `<span style="font-size:10px; font-weight:bold;">${i + 1}</span>`;

            for (let intento = 0; intento < MAX_INTENTOS; intento++) {
                if (cancelado) return;

                const btnGen = ejActual.querySelector('.btGenerar');
                const btnRep = ejActual.querySelector('.btRepetir');
                const usarGenerar = (intento === 0 && btnGen && esVisible(btnGen) && !(btnRep && esVisible(btnRep)));
                const botonAccion = usarGenerar ? btnGen : btnRep;

                if (botonAccion) {
                    const antesHTML = ejActual.innerHTML;
                    botonAccion.click();
                    await esperarHasta(() => ejActual.innerHTML !== antesHTML, 2500);
                    await sleep(150);
                }

                if (cancelado) return;

                const numEnunciado = ejActual.getAttribute('enunciado');
                let ejResuelto = doc.querySelector(`div.ejercicio[id="${id}"][enunciado="${numEnunciado}"]`);

                const tieneCampos = ejActual.querySelector(SEL_TODO) !== null;
                const soloOpciones = ejActual.querySelector('p.opcionMultiple') !== null && !ejActual.querySelector(SEL_CAMPOS);
                if (soloOpciones) {
                    const todasConocidas = Array.from(ejActual.querySelectorAll('p.opcionMultiple'))
                        .every(p => conocimiento.has(textoOpcion(p)));
                    if (!todasConocidas) ejResuelto = null;
                } else if (ejResuelto && tieneCampos && firmaCampos(ejResuelto) !== firmaCampos(ejActual)) {
                    ejResuelto = null;
                }

                const btnCorregir = ejActual.querySelector('.btCorregir, #btCorregir');

                if (ejResuelto) {
                    const liveCalculadoras = Array.from(ejActual.querySelectorAll('.calculadora'));
                    const sourceCalculadoras = Array.from(ejResuelto.querySelectorAll('.calculadora'));

                    const srcDiag    = sourceCalculadoras.filter(esDiagramaSrc);
                    const srcNoDiag  = sourceCalculadoras.filter(c => !esDiagramaSrc(c));
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
                        if (cancelado) return;
                        if (esDiagramaVivo(liveCalc)) {
                            const srcCalc = srcDiag[idxDiag++];
                            if (!srcCalc) continue;
                            const res = await procesarDiagrama(liveCalc, srcCalc);
                            if (res === false) diagramaFallo = true;
                        } else {
                            const textos = planPorCalc.get(liveCalc) || [];
                            for (let k = 0; k < textos.length; k++) {
                                await escribirCelda(liveCalc, k, textos[k]);
                            }
                        }
                    }

                    if (diagramaFallo && intento < MAX_INTENTOS - 1) {
                        if (btnCorregir && !cancelado) {
                            btnCorregir.removeAttribute('disabled');
                            btnCorregir.disabled = false;
                            btnCorregir.click();
                            await sleep(700);
                        }
                        continue;
                    }

                    if (tieneCampos && !cancelado) {
                        const srcLit = ejResuelto.querySelectorAll('.campo_literal');
                        const liveLit = ejActual.querySelectorAll('.campo_literal');
                        for (let k = 0; k < liveLit.length; k++) {
                            if (!srcLit[k] || cancelado) continue;
                            const campo = liveLit[k];
                            campo.textContent = norm(srcLit[k].textContent);
                            campo.dispatchEvent(new Event('input', { bubbles: true }));
                            campo.dispatchEvent(new Event('keyboard', { bubbles: true }));
                            campo.dispatchEvent(new Event('change', { bubbles: true }));
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
                            if (cancelado) return;
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

                    if (btnCorregir && !cancelado) {
                        btnCorregir.removeAttribute('disabled');
                        btnCorregir.disabled = false;
                        btnCorregir.click();
                        await sleep(700);
                    }

                    reemplazados++;
                    break;

                } else {
                    let enviado = null;
                    if (soloOpciones) {
                        llenarOpciones(ejActual);
                        enviado = new Map(Array.from(ejActual.querySelectorAll('p.opcionMultiple'))
                            .map(p => [textoOpcion(p), p.querySelector('input').checked]));
                    }
                    if (btnCorregir && !cancelado) {
                        btnCorregir.removeAttribute('disabled');
                        btnCorregir.disabled = false;
                        btnCorregir.click();
                        await sleep(700);
                    }
                    if (enviado && !cancelado) {
                        aprenderOpciones(ejActual, enviado);
                    }
                }
            }
        }

        if (reemplazados === 0 && omitidos > 0) {
            const motivo = modo === 'no_iniciados' ? 'ya estaban iniciados' : (modo === 'iniciados' ? 'todos los iniciados ya tienen nota 100' : 'sin botones activos');
            showToast(`No se inyectó nada: ${omitidos} ejercicios omitidos (${motivo}).`, 'info');
            resetearBtn();
            return;
        }

        if (reemplazados === 0) {
            showToast('No se pudo emparejar ningún ejercicio con el archivo.', 'warning');
            resetearBtn();
            return;
        }

        resetearBtn();
    }

    // Acción 1: Descarga bajo demanda desde GitHub
    btnGitHub.addEventListener('click', async () => {
        if (btnGitHub.disabled) return;

        const meta = obtenerMetadatosCapitulo();
        if (!meta) {
            showToast('No se pudo detectar la materia ni el capítulo en la página.', 'error');
            return;
        }

        btnGitHub.disabled = true;
        btnLocal.disabled = true;
        selectModo.disabled = true;
        btnGitHub.innerHTML = `<span style="font-size:10px; font-weight:bold;">...</span>`;
        btnGitHub.style.opacity = '0.7';

        try {
            const html = await descargarHTMLDesdeGitHub(meta);
            await ejecutarInyeccionConHTML(html);
        } catch (err) {
            showToast(err.message || 'Error al conectar con GitHub.', 'error');
            resetearBtn();
        }
    });

    // Acción 2: Carga manual desde PC
    btnLocal.addEventListener('click', () => {
        if (!btnLocal.disabled) inputFile.click();
    });

    inputFile.addEventListener('change', () => {
        const file = inputFile.files[0];
        if (!file) return;

        btnGitHub.disabled = true;
        btnLocal.disabled = true;
        selectModo.disabled = true;
        btnGitHub.innerHTML = `<span style="font-size:10px; font-weight:bold;">...</span>`;
        btnGitHub.style.opacity = '0.7';

        const reader = new FileReader();
        reader.onload = async (e) => {
            inputFile.value = '';
            await ejecutarInyeccionConHTML(e.target.result);
        };
        reader.readAsText(file);
    });
})();
