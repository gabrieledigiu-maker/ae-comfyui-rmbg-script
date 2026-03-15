// ============================================================
//  RMBG for After Effects  v4.0
//
//  Flusso completamente asincrono — AE non si blocca mai:
//  1. JSX salva l'immagine su disco
//  2. JSX scrive un job.json con tutti i parametri
//  3. JSX lancia rmbg_launch.vbs via wscript (torna subito)
//  4. Il VBS lancia Python in background (WshShell.Run ... False)
//  5. JSX fa polling su status.json ogni 2s con File.exists
//  6. Quando status="done", importa il PNG in AE
// ============================================================

(function (thisObj) {

    var NAME    = "RMBG for AE";
    var VERSION = "4.0";

    // ── Percorsi basati sulla posizione del file JSX ────────
    var SCRIPT_FILE  = new File($.fileName);
    var SCRIPT_DIR   = SCRIPT_FILE.parent.fsName;
    // La cartella "server" è accanto alla cartella "jsx"
    var SERVER_DIR   = new Folder(SCRIPT_DIR + "\\..\\server").fsName;
    var PROCESS_PY   = SERVER_DIR + "\\rmbg_process.py";
    var LAUNCHER_VBS = SERVER_DIR + "\\rmbg_launch.vbs";
    var TMP_DIR      = Folder.temp.fsName + "\\rmbg_ae";

    var IS_WIN = ($.os.toLowerCase().indexOf("win") !== -1);

    // ── Job corrente ────────────────────────────────────────
    var _job = null;

    // ═══════════════════════════════════════════════════════
    //  CONFIG  (salva/carica percorso ComfyUI)
    // ═══════════════════════════════════════════════════════
    var CONFIG_PATH = SERVER_DIR + "\\rmbg_config.json";

    function loadConfig() {
        var f = new File(CONFIG_PATH);
        if (!f.exists) return {};
        f.encoding = "UTF-8"; f.open("r");
        var t = f.read(); f.close();
        try { return JSON.parse(t); } catch(e) { return {}; }
    }

    function saveConfig(cfg) {
        var f = new File(CONFIG_PATH);
        f.encoding = "UTF-8"; f.open("w");
        f.write(JSON.stringify(cfg, null, 2)); f.close();
    }

    function findPython(comfyuiPath) {
        if (!comfyuiPath) return "python";
        var base   = comfyuiPath.replace(/[\/\\]+$/, "");
        // ComfyUI-Easy-Install mette python_embeded UNA cartella sopra ComfyUI
        var parent = base.replace(/[\/\\][^\/\\]+$/, "");
        var tries = [
            base   + "\\python_embeded\\python.exe",
            base   + "\\python_embedded\\python.exe",
            parent + "\\python_embeded\\python.exe",
            parent + "\\python_embedded\\python.exe",
            base   + "\\venv\\Scripts\\python.exe",
        ];
        for (var i = 0; i < tries.length; i++) {
            if (new File(tries[i]).exists) return tries[i];
        }
        return "python";
    }

    function findComfyUI() {
        var cfg = loadConfig();
        if (cfg.comfyui_path && new Folder(cfg.comfyui_path).exists)
            return cfg.comfyui_path;
        var candidates = [
            "D:\\NewComfy\\ComfyUI-Easy-Install\\ComfyUI",
            Folder.userData.fsName + "\\ComfyUI",
            "C:\\ComfyUI", "C:\\AI\\ComfyUI", "D:\\ComfyUI",
        ];
        for (var i = 0; i < candidates.length; i++)
            if (new Folder(candidates[i]).exists) return candidates[i];
        return "";
    }

    // ═══════════════════════════════════════════════════════
    //  FILE UTILS
    // ═══════════════════════════════════════════════════════

    function ensureDir(p) {
        var f = new Folder(p);
        if (!f.exists) f.create();
        return p;
    }

    // Rimuove tutti i file residui dalla cartella temp (da sessioni precedenti)
    function cleanTmpDir() {
        var folder = new Folder(TMP_DIR);
        if (!folder.exists) return;
        var files = folder.getFiles();
        var patterns = /^(input_|status_|log_|rmbg_|run_|adj_)/;
        for (var i = 0; i < files.length; i++) {
            try {
                if (files[i] instanceof File && patterns.test(files[i].name)) {
                    files[i].remove();
                }
            } catch(e) {}
        }
    }

    function readJSON(path) {
        var f = new File(path);
        if (!f.exists) return null;
        f.encoding = "UTF-8"; f.open("r");
        var t = f.read(); f.close();
        try { return JSON.parse(t); } catch(e) { return null; }
    }

    function writeJSON(path, obj) {
        var f = new File(path);
        f.encoding = "UTF-8"; f.open("w");
        f.write(JSON.stringify(obj, null, 2)); f.close();
    }

    function copyFileSafe(src, dst) {
        var s = new File(src);
        if (!s.exists) throw new Error("Sorgente non trovata:\n" + src);
        var d = new File(dst);
        if (d.exists) d.remove();
        // Prima prova l'API nativa
        if (s.copy(dst)) {
            var c = new File(dst);
            if (c.exists && c.length > 0) return;
        }
        // Fallback shell copy (non blocca AE significativamente)
        app.system('cmd /C copy /Y "' + s.fsName + '" "' + d.fsName + '" >NUL 2>&1');
        var c2 = new File(dst);
        if (!c2.exists || c2.length === 0)
            throw new Error("Copia file fallita:\n" + src + "\n→ " + dst);
    }

    // ═══════════════════════════════════════════════════════
    //  AE HELPERS
    // ═══════════════════════════════════════════════════════

    var STATIC_EXTS = /\.(png|jpe?g|tiff?|bmp|tga|exr|dpx|hdr|gif|webp)$/i;

    function activeComp() {
        var c = app.project.activeItem;
        if (!c || !(c instanceof CompItem))
            throw new Error("Nessuna composizione attiva.\nSeleziona una composizione.");
        return c;
    }

    function selectedLayer() {
        var c = activeComp();
        if (!c.selectedLayers.length)
            throw new Error("No layer selected.\nSelect a layer in the composition.");
        return c.selectedLayers[0];
    }

    function staticSourceFile(layer) {
        try {
            var src = layer.source;
            if (src && src instanceof FootageItem && src.file) {
                var f = src.file;
                if (f instanceof File && f.exists && STATIC_EXTS.test(f.name)) return f;
            }
        } catch(e) {}
        return null;
    }

    // Rileva se il layer è una sequenza PNG importata come tale
    function isImageSequence(layer) {
        try {
            var src = layer.source;
            if (!(src instanceof FootageItem)) return false;
            if (!src.file) return false;
            // Una sequenza ha duration > 1 frame E il file sorgente è un PNG/JPG
            var fps = src.frameRate || 25;
            var nFrames = Math.round(src.duration * fps);
            return nFrames > 1 && STATIC_EXTS.test(src.file.name);
        } catch(e) { return false; }
    }

    // Ottieni la cartella e il pattern di una sequenza
    function getSequenceInfo(layer) {
        try {
            var src = layer.source;
            var f = src.file;
            var folder = f.parent.fsName;
            // Il pattern: AE nomina il file con il numero del primo frame
            // Ricaviamo il pattern cercando tutti i file con stessa estensione nella cartella
            var ext = f.name.match(/\.[^.]+$/)[0];
            return { folder: folder, pattern: "*" + ext, firstFile: f.name };
        } catch(e) { return null; }
    }

    // Render singolo frame (solo per layer video)
    function renderFrame(layer, comp, outPath, log) {
        log("     Render queue " + comp.width + "x" + comp.height +
            " t=" + comp.time.toFixed(2) + "s");
        var fps = comp.frameRate, t = comp.time;
        var tc = app.project.items.addComp("__RMBG__", comp.width, comp.height,
                                            comp.pixelAspect, 1.0/fps, fps);
        var nl;
        try { nl = tc.layers.add(layer.source); } catch(e) { nl = null; }
        if (!nl) try { nl = layer.copyToComp(tc); } catch(e) { nl = null; }
        if (!nl) {
            try { tc.remove(); } catch(e) {}
            throw new Error(
                "Cannot add layer to temporary comp.\n" +
                "Select a video or image layer."
            );
        }
        try { nl.startTime = -t; } catch(e) {}

        var rq = app.project.renderQueue.items.add(tc);
        rq.timeSpanStart = 0;
        rq.timeSpanDuration = 1.0 / fps;
        var om = rq.outputModule(1);
        var tpls = ["PNG [Channels - RGBA]","PNG+Alpha","PNG","Lossless with Alpha","Lossless"];
        for (var i = 0; i < tpls.length; i++) {
            try { om.applyTemplate(tpls[i]); break; } catch(e) {}
        }
        om.file = new File(outPath);
        try { app.project.renderQueue.render(); } catch(e) {
            try { rq.remove(); } catch(ee) {}
            try { tc.remove(); } catch(ee) {}
            throw new Error("Render failed: " + e.message);
        }
        try { rq.remove(); } catch(e) {}
        try { tc.remove(); } catch(e) {}

        // AE aggiunge a volte un suffisso numerico al filename
        if (!new File(outPath).exists) {
            var base = outPath.replace(/\.(png|tif)$/i, "");
            var ext  = (outPath.match(/\.(png|tif)$/i) || [".png"])[0];
            var sfxs = ["[00000000]","[0000000]","_00000000","00000000","_00000","00000"];
            for (var si = 0; si < sfxs.length; si++) {
                var c = new File(base + sfxs[si] + ext);
                if (c.exists) { c.copy(outPath); try{c.remove();}catch(e){} break; }
            }
        }
        if (!new File(outPath).exists)
            throw new Error("File not found after render: " + outPath);
        log("     Frame OK: " + new File(outPath).length + " bytes");
    }

    // ═══════════════════════════════════════════════════════
    //  LAUNCH — scrive job.json e lancia il VBS
    //  wscript torna in <100ms, Python gira in background
    // ═══════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────
    // LAUNCH — usa File.execute() che è disponibile in tutti
    // i AE moderni. Scrive un .bat e lo "apre" (= doppio-click):
    // cmd.exe lo esegue e AE torna subito senza aspettare.
    // Il .bat usa "start /B" per lanciare Python in background.
    // ─────────────────────────────────────────────────────────
    function launchVBS(jobData, logPath) {
        jobData.log = logPath;

        if (IS_WIN) {
            var argParts = [];

            if (jobData.input_dir !== undefined) {
                // Sequenza: argomenti di rmbg_sequence.py
                var seqKeys = [
                    ["input_dir","input_dir"],["output_dir","output_dir"],
                    ["pattern","pattern"],["process_py","process_py"],
                    ["python_exe","python_exe"],
                    ["status","status"],["model","model"],
                    ["comfyui_path","comfyui"],
                    ["mask_expand","mask_expand"],["mask_blur","mask_blur"]
                ];
                for (var i = 0; i < seqKeys.length; i++) {
                    var jk = seqKeys[i][0], ak = seqKeys[i][1];
                    if (jobData[jk] !== undefined)
                        argParts.push("--" + ak + ' "' + String(jobData[jk]) + '"');
                }
                if (jobData.invert_mask === "true") argParts.push("--invert");
                if (jobData.save_matte  === "true") argParts.push("--save_matte");
            } else {
                // Singola immagine: argomenti di rmbg_process.py
                var keys = [["input","input"],["output","output"],["status","status"],
                            ["model","model"],["comfyui_path","comfyui"],
                            ["mask_expand","mask_expand"],["mask_blur","mask_blur"]];
                for (var i = 0; i < keys.length; i++) {
                    var jk = keys[i][0], ak = keys[i][1];
                    if (jobData[jk] !== undefined)
                        argParts.push("--" + ak + ' "' + String(jobData[jk]) + '"');
                }
                if (jobData.invert_mask === "true") argParts.push("--invert");
                if (jobData.save_matte  === "true") argParts.push("--save_matte");
            }
            var argStr = argParts.join(" ");

            // Scrivi .bat che usa "start /B" per background reale
            var batPath = TMP_DIR + "\\rmbg_" + new Date().getTime() + ".bat";
            var bf = new File(batPath);
            bf.encoding = "UTF-8"; bf.open("w");
            bf.writeln("@echo off");
            bf.writeln("chcp 65001 >nul");
            // Usa variabili per path con spazi — più robusto di inline quoting
            bf.writeln('set "PYEXE=' + jobData.python_exe + '"');
            bf.writeln('set "PYSCRIPT=' + jobData.script_path + '"');
            bf.writeln('start /B "" "%PYEXE%" "%PYSCRIPT%" ' + argStr +
                       ' >> "' + logPath + '" 2>&1');
            bf.close();

            // VBS lancia il bat nascosto (nessuna finestra), poi cancella bat+vbs
            var vbsPath = TMP_DIR + "\\run_" + new Date().getTime() + ".vbs";
            var bp = batPath.replace(/\\/g, "\\\\");
            var vp = vbsPath.replace(/\\/g, "\\\\");
            var vf = new File(vbsPath);
            vf.encoding = "UTF-8"; vf.open("w");
            vf.writeln('Set sh  = CreateObject("WScript.Shell")');
            vf.writeln('Set fso = CreateObject("Scripting.FileSystemObject")');
            vf.writeln('sh.Run "cmd /C """ & "' + bp + '" & """", 0, True');
            vf.writeln('On Error Resume Next');
            vf.writeln('fso.DeleteFile "' + bp + '"');
            vf.writeln('fso.DeleteFile "' + vp + '"');
            vf.close();
            new File(vbsPath).execute();

        } else {
            // macOS/Linux
            var ap2 = [];
            var keys2 = [["input","input"],["output","output"],["status","status"],
                         ["model","model"],["comfyui_path","comfyui"],
                         ["mask_expand","mask_expand"],["mask_blur","mask_blur"]];
            for (var j = 0; j < keys2.length; j++) {
                var jk2 = keys2[j][0], ak2 = keys2[j][1];
                if (jobData[jk2] !== undefined) {
                    ap2.push("--" + ak2 + " '" +
                              String(jobData[jk2]).replace(/'/g, "'\''") + "'");
                }
            }
            if (jobData.invert_mask === "true") ap2.push("--invert");

            var shPath = TMP_DIR + "/rmbg_" + new Date().getTime() + ".sh";
            var sf = new File(shPath);
            sf.encoding = "UTF-8"; sf.open("w");
            sf.writeln("#!/bin/sh");
            sf.writeln('"' + jobData.python_exe + '" "' + jobData.script_path + '" ' +
                       ap2.join(" ") + ' >> "' + logPath + '" 2>&1 &');
            sf.close();
            new File(shPath).execute();
        }
    }

    // ═══════════════════════════════════════════════════════
    //  POLLING — solo File.exists + readJSON, nessuna socket
    // ═══════════════════════════════════════════════════════
    function startPolling() {
        // Registra la callback come globale (richiesto da scheduleTask con stringa)
        $.global["__rmbg_poll"] = _poll;
        app.scheduleTask("__rmbg_poll()", 2000, false);
    }

    function _poll() {
        if (!_job) return;

        var st = readJSON(_job.statusPath);

        if (!st) {
            // Python non ancora partito o JSON non ancora scritto
            _job.log("     …starting Python…");
            startPolling();
            return;
        }

        _job.log("     Python: [" + st.status + "]  " + (st.progress || ""));

        if (st.status === "done" || st.status === "done_with_errors") {
            var job = _job; _job = null;
            _importResult(job, st);

        } else if (st.status === "error") {
            var job2 = _job; _job = null;
            var detail = st.error || "unknown error";
            var logContent = "";
            try {
                var lf = new File(job2.logPath);
                if (lf.exists) {
                    lf.encoding = "UTF-8"; lf.open("r");
                    logContent = lf.read(); lf.close();
                    if (logContent.length > 1000)
                        logContent = "…\n" + logContent.substring(logContent.length - 1000);
                }
            } catch(e) {}
            // Pulizia file temp anche in caso di errore
            try { new File(job2.statusPath).remove(); } catch(e) {}
            try { new File(job2.logPath).remove();    } catch(e) {}
            try { new File(job2.input).remove();      } catch(e) {}
            job2.onError(detail + (logContent ? "\n\n--- Log Python ---\n" + logContent : ""));

        } else {
            // "starting" | "loading" | "processing" | "saving"
            startPolling();
        }
    }

    function _importResult(job, st) {
        try {
            // Pulizia file temp
            try { new File(job.statusPath).remove(); } catch(e) {}
            try { new File(job.logPath).remove();    } catch(e) {}
            try { if (job.input) new File(job.input).remove(); } catch(e) {}

            if (job.isSequence) {
                // ── IMPORTA SEQUENZA ──────────────────────────────────
                var outDir = job.outputDir || st.output_dir;
                var total  = st.total || "?";
                var errs   = (st.errors && st.errors.length) ? st.errors.length : 0;

                if (errs > 0) {
                    job.log("     ⚠ Completed with " + errs + " errors out of " + total + " frames.");
                }

                // Trova il primo file PNG nella cartella output per importare come sequenza
                var outFolder = new Folder(outDir);
                var pngFiles  = outFolder.getFiles("*.png");
                if (!pngFiles || pngFiles.length === 0)
                    throw new Error("No PNG found in output folder:\n" + outDir);

                pngFiles.sort(function(a,b){ return a.name > b.name ? 1 : -1; });
                var firstFile = pngFiles[0];

                app.beginUndoGroup("RMBG Sequence Import");
                var io = new ImportOptions(firstFile);
                io.importAs = ImportAsType.FOOTAGE;
                io.sequence = true;
                var footage = app.project.importFile(io);
                footage.name = job.layer.name + " [NoBG]";
                // Copia il frame rate dalla comp sorgente
                try {
                    footage.mainSource.conformFrameRate = job.comp.frameRate;
                } catch(e) {}
                // Imposta durata corretta
                try {
                    var seqFps = job.comp.frameRate;
                    var pngFiles2 = new Folder(outDir).getFiles("*.png");
                    footage.mainSource.conformFrameRate = seqFps;
                } catch(e) {}

                var newLyr = job.comp.layers.add(footage);
                newLyr.startTime = job.layer.startTime;
                try { newLyr.outPoint = job.layer.outPoint; } catch(e) {}
                newLyr.moveAfter(job.layer);
                app.endUndoGroup();

                job.onDone(footage, outDir, outDir, job.pythonExe,
                           footage.name, total + " frame · " + (st.model || "?"));

            } else {
                // ── IMPORTA SINGOLA IMMAGINE ──────────────────────────
                var outFile = new File(job.outputPath);
                if (!outFile.exists)
                    throw new Error("Output file not found:\n" + job.outputPath);

                app.beginUndoGroup("RMBG Remove Background");
                var footage = app.project.importFile(new ImportOptions(outFile));
                footage.name = job.layer.name + " [NoBG]";
                var newLyr = job.comp.layers.add(footage);
                newLyr.startTime = job.layer.startTime;
                try { newLyr.outPoint = job.layer.outPoint; } catch(e) {}
                newLyr.moveAfter(job.layer);
                app.endUndoGroup();

                // Importa il matte B/N se salvato
                if (st.matte_path) {
                    try {
                        var matteFile = new File(st.matte_path);
                        if (matteFile.exists) {
                            var matteFootage = app.project.importFile(new ImportOptions(matteFile));
                            matteFootage.name = job.layer.name + " [Matte]";
                            try {
                                var matteFolder = null;
                                for (var fi = 1; fi <= app.project.numItems; fi++) {
                                    if (app.project.item(fi) instanceof FolderItem &&
                                        app.project.item(fi).name === "RMBG Mattes") {
                                        matteFolder = app.project.item(fi); break;
                                    }
                                }
                                if (!matteFolder) matteFolder = app.project.items.addFolder("RMBG Mattes");
                                matteFootage.parentFolder = matteFolder;
                            } catch(e) {}
                        }
                    } catch(e) {}
                }

                var origPath = job.outputPath.replace(/\.png$/i, "_orig.png");
                try {
                    var srcF = new File(job.outputPath);
                    var dstF = new File(origPath);
                    srcF.copy(dstF);
                } catch(e) { origPath = job.outputPath; }

                job.onDone(footage, job.outputPath, origPath, job.pythonExe,
                           footage.name, (st.model || "?") + " · " + (st.device || "?"));
            }

        } catch(e) {
            try { app.endUndoGroup(); } catch(ee) {}
            job.onError("Import failed: " + e.message);
        }
    }

    // ═══════════════════════════════════════════════════════
    //  ENTRY POINT
    // ═══════════════════════════════════════════════════════
    function startProcessing(params, log, onDone, onError) {
        try {
            var comfyuiPath = params.comfyuiPath;
            if (!comfyuiPath || !new Folder(comfyuiPath).exists)
                throw new Error("Invalid ComfyUI path:\n" + comfyuiPath);

            var pythonExe = findPython(comfyuiPath);
            log("     Python: " + pythonExe);
            log("     ComfyUI: " + comfyuiPath);

            // Verifica script Python
            if (!new File(PROCESS_PY).exists)
                throw new Error("rmbg_process.py not found:\n" + PROCESS_PY);

            // Prepara cartella temp
            ensureDir(TMP_DIR);
            var ts = String(new Date().getTime());
            var inputPath  = TMP_DIR + "\\input_"  + ts + ".png";
            var statusPath = TMP_DIR + "\\status_" + ts + ".json";
            var logPath    = TMP_DIR + "\\log_"    + ts + ".txt";

            // Acquisisci il frame
            var comp  = activeComp();
            var layer = selectedLayer();

            // Determina cartella output: sottocartella "RMBG" nella cartella progetto
            var outputDir = TMP_DIR;  // fallback se progetto non salvato
            var projectFile = app.project.file;
            if (projectFile && projectFile instanceof File && projectFile.exists) {
                var rmbgFolder = new Folder(projectFile.parent.fsName + "\\RMBG");
                if (!rmbgFolder.exists) rmbgFolder.create();
                outputDir = rmbgFolder.fsName;
                log("     Output: " + outputDir);
            } else {
                log("     ⚠ Project not saved — output in temp folder.");
            }
            // Nome file basato sul layer — rimuove caratteri speciali e tronca a 40 chars
            var safeName = layer.name
                .replace(/[\/\\:*?"<>|%]/g, "_")  // caratteri vietati
                .replace(/\.png$/i, "")             // estensione finale
                .replace(/\./g, "_");               // altri punti (es. .mp4.00_00...)
            if (safeName.length > 40) safeName = safeName.substring(0, 40);
            var outputPath = outputDir + "\\" + safeName + "_NoBG_" + ts + ".png";
            log("     Output file: " + safeName + "_NoBG_" + ts + ".png");
            log("     Layer: " + layer.name);

            var sf = staticSourceFile(layer);
            var isSeq = isImageSequence(layer);

            if (isSeq) {
                // ── SEQUENZA PNG ──────────────────────────────────────
                var seqInfo = getSequenceInfo(layer);
                if (!seqInfo) throw new Error("Cannot read sequence.");

                var srcFolderName = new Folder(seqInfo.folder).name;
                var seqOutDir = outputDir + "\\" + srcFolderName.substring(0, 30) + "_NoBG_" + ts;
                log("     Sequence: " + seqInfo.folder);
                log("     Output: " + seqOutDir);

                var SEQ_PY = SERVER_DIR + "\\rmbg_sequence.py";
                if (!new File(SEQ_PY).exists)
                    throw new Error("rmbg_sequence.py not found:\n" + SEQ_PY);

                var jobData = {
                    python_exe:  pythonExe,
                    script_path: SEQ_PY,
                    input_dir:   seqInfo.folder,
                    output_dir:  seqOutDir,
                    pattern:     seqInfo.pattern,
                    process_py:  PROCESS_PY,
                    status:      statusPath,
                    model:       params.model,
                    comfyui_path: comfyuiPath,
                    mask_expand: String(params.maskExpand),
                    mask_blur:   String(params.maskBlur),
                    invert_mask: params.invertMask ? "true" : "false",
                    save_matte:  params.saveMatte  ? "true" : "false"
                };

                log("     Launching Python (background)…");
                launchVBS(jobData, logPath);
                log("     Process started. Waiting for completion…");
                log("     Python log: " + logPath);

                _job = {
                    statusPath:  statusPath,
                    outputDir:   seqOutDir,
                    logPath:     logPath,
                    input:       null,
                    comp:        comp,
                    layer:       layer,
                    pythonExe:   pythonExe,
                    isSequence:  true,
                    log:         log,
                    onDone:      onDone,
                    onError:     onError
                };

            } else {
                // ── SINGOLA IMMAGINE / FRAME ──────────────────────────
                if (sf) {
                    log("     Image: " + sf.name + "  (" + sf.length + " bytes)");
                    var ext = sf.name.match(/\.[^.]+$/)[0].toLowerCase();
                    inputPath = TMP_DIR + "\\input_" + ts + ext;
                    copyFileSafe(sf.fsName, inputPath);
                } else {
                    log("     Video layer → render queue…");
                    renderFrame(layer, comp, inputPath, log);
                }
                log("     Input ready: " + new File(inputPath).length + " bytes");

                var jobData = {
                    python_exe:  pythonExe,
                    script_path: PROCESS_PY,
                    input:       inputPath,
                    output:      outputPath,
                    status:      statusPath,
                    model:       params.model,
                    comfyui_path: comfyuiPath,
                    mask_expand: String(params.maskExpand),
                    mask_blur:   String(params.maskBlur),
                    invert_mask: params.invertMask ? "true" : "false",
                    save_matte:  params.saveMatte  ? "true" : "false"
                };

                log("     Launching Python (background)…");
                launchVBS(jobData, logPath);
                log("     Process started. Waiting for completion…");
                log("     Python log: " + logPath);

                _job = {
                    statusPath: statusPath,
                    outputPath: outputPath,
                    logPath:    logPath,
                    input:      inputPath,
                    comp:       comp,
                    layer:      layer,
                    pythonExe:  pythonExe,
                    isSequence: false,
                    log:        log,
                    onDone:     onDone,
                    onError:    onError
                };
            }

            startPolling();

        } catch(e) {
            onError(e.message);
        }
    }

    // ═══════════════════════════════════════════════════════
    //  UI
    // ═══════════════════════════════════════════════════════
    function buildUI(host) {
        var win = (host instanceof Panel)
            ? host
            : new Window("palette", NAME + "  v" + VERSION, undefined, {resizeable:true});
        win.orientation = "column";
        win.alignChildren = ["fill","top"];
        win.margins = 12; win.spacing = 8;

        // Titolo
        var tr = win.add("group"); tr.alignment = ["center","top"];
        var tl = tr.add("statictext", undefined, "⬡  RMBG for After Effects  v" + VERSION);
        try {
            tl.graphics.foregroundColor =
                tl.graphics.newPen(tl.graphics.PenType.SOLID_COLOR,[0.35,0.7,1.0],1);
        } catch(e) {}

        win.add("panel",[0,0,0,1]);

        // ComfyUI path
        var cfgPnl = win.add("panel",undefined,"Configuration");
        cfgPnl.orientation="column"; cfgPnl.alignChildren=["fill","top"];
        cfgPnl.margins=8; cfgPnl.spacing=5;

        var cpRow = cfgPnl.add("group");
        cpRow.add("statictext",undefined,"ComfyUI:").preferredSize.width=55;
        var cpInput = cpRow.add("edittext",undefined,"");
        cpInput.preferredSize.width=190;
        var cpBtn = cpRow.add("button",undefined,"…");
        cpBtn.preferredSize.width=25;

        var pyLbl = cfgPnl.add("statictext",undefined,"Python: —",{multiline:false});
        pyLbl.alignment=["fill","top"];

        // Carica config
        var cfg = loadConfig();
        var initPath = cfg.comfyui_path || findComfyUI();
        if (initPath) {
            cpInput.text = initPath;
            pyLbl.text = "Python: " + findPython(initPath);
        }

        cpBtn.onClick = function() {
            var f = Folder.selectDialog("Seleziona la cartella ComfyUI");
            if (f) {
                cpInput.text = f.fsName;
                pyLbl.text = "Python: " + findPython(f.fsName);
                saveConfig({comfyui_path: f.fsName});
            }
        };
        cpInput.onChange = function() {
            if (new Folder(cpInput.text).exists) {
                pyLbl.text = "Python: " + findPython(cpInput.text);
                saveConfig({comfyui_path: cpInput.text});
            }
        };

        win.add("panel",[0,0,0,1]);

        // Info cartella output
        var outPnl = win.add("panel",undefined,"Output");
        outPnl.orientation="column"; outPnl.alignChildren=["fill","top"];
        outPnl.margins=8; outPnl.spacing=4;
        var outLbl = outPnl.add("statictext",undefined,"📁 Folder: (save the .aep project first)",{multiline:true});
        outLbl.preferredSize=[300,30]; outLbl.alignment=["fill","top"];
        var outBtn = outPnl.add("button",undefined,"Save project (Ctrl+S)");
        outBtn.preferredSize.height=22;

        function refreshOutputPath() {
            var pf = app.project.file;
            if (pf && pf instanceof File && pf.exists) {
                outLbl.text = "📁 " + pf.parent.fsName;
                outBtn.enabled = false;
                outBtn.text = "✓ Project saved";
            } else {
                outLbl.text = "⚠ Project not saved — output will go to temp folder";
                outBtn.enabled = true;
                outBtn.text = "Save project (Ctrl+S)";
            }
        }
        refreshOutputPath();
        cleanTmpDir(); // Pulizia residui temp da sessioni precedenti
        outBtn.onClick = function() {
            app.executeCommand(3); // Cmd ID 3 = File > Save
            refreshOutputPath();
        };

        win.add("panel",[0,0,0,1]);

        // Modello
        var mr = win.add("group");
        mr.add("statictext",undefined,"Model:").preferredSize.width=60;
        var mDrop = mr.add("dropdownlist",undefined,
            ["RMBG-2.0","BiRefNet-general","BiRefNet-HR","BiRefNet-HR-matting","SAM3-L","SAM3-L-HQ","SAM3-B+"]);
        mDrop.selection = 0;
        mDrop.preferredSize.width = 185;

        win.add("panel",[0,0,0,1]);

        // Parametri maschera
        var pp = win.add("panel",undefined,"Mask Parameters");
        pp.orientation="column"; pp.alignChildren=["fill","top"];
        pp.margins=8; pp.spacing=5;

        // Stato del layer/footage corrente per la preview
        var _previewFootage   = null;   // FootageItem importato
        var _previewOutPath   = null;   // path del PNG corrente su disco (viene sovrascritto)
        var _previewOrigPath  = null;   // path del PNG originale (mai modificato — base per adjust)
        var _previewPythonExe = null;   // python exe da usare per adjust
        var _adjustTimer      = null;   // timer debounce

        function slRow(par, lbl, def, mn, mx, step) {
            var g = par.add("group");
            g.add("statictext",undefined,lbl).preferredSize.width=90;
            var sl = g.add("slider",undefined,def,mn,mx); sl.preferredSize.width=100;
            var vl = g.add("statictext",undefined,def.toFixed(1));
            vl.preferredSize.width=36;
            sl.onChanging = function() {
                // Snappa al multiplo di step più vicino
                var snapped = Math.round(sl.value / step) * step;
                vl.text = snapped.toFixed(1);
                scheduleAdjust();
            };
            sl.onChange = function() {
                var snapped = Math.round(sl.value / step) * step;
                sl.value = snapped;
                vl.text = snapped.toFixed(1);
                scheduleAdjust();
            };
            sl._step = step;
            return sl;
        }
        // Expand: -10 → +10 px, step 0.5 (mezzo pixel per tacca)
        // Blur:     0 → 15,   step 0.5
        var expSl  = slRow(pp, "Mask Expand:", 0.0, -10, 10, 0.5);
        var blurSl = slRow(pp, "Mask Blur:",   0.0,   0, 15, 0.5);
        var invRow = pp.add("group");
        invRow.add("statictext",undefined,"Invert:").preferredSize.width=90;
        var invCb  = invRow.add("checkbox");
        invCb.onClick = function() { scheduleAdjust(); };

        var matteRow = pp.add("group");
        matteRow.add("statictext",undefined,"Save matte:").preferredSize.width=90;
        var matteCb = matteRow.add("checkbox");
        var matteTip = matteRow.add("statictext",undefined,"(separate B&W)");
        matteTip.helpTip = "Saves a B&W PNG of the alpha channel only — useful to inspect matte quality";

        var previewLbl = pp.add("statictext",undefined,"Adjust sliders after the first render.");
        previewLbl.preferredSize=[300,18]; previewLbl.alignment=["fill","top"];

        // Disabilita slider finché non c'è un risultato
        expSl.enabled  = false;
        blurSl.enabled = false;
        invCb.enabled  = false;

        // ── Debounce: aspetta 800ms di inattività prima di lanciare adjust ──
        function scheduleAdjust() {
            if (!_previewOutPath || !_previewFootage) return;
            if (_adjustTimer !== null) {
                try { app.cancelTask(_adjustTimer); } catch(e) {}
                _adjustTimer = null;
            }
            previewLbl.text = "⏳ Updating...";
            $.global["__rmbg_adjust"] = function() { _runAdjust(); };
            _adjustTimer = app.scheduleTask("__rmbg_adjust()", 800, false);
        }

        function _runAdjust() {
            _adjustTimer = null;
            if (!_previewOutPath || !_previewFootage) return;

            var ADJUST_PY = SERVER_DIR + "\\rmbg_adjust.py";
            if (!new File(ADJUST_PY).exists) {
                previewLbl.text = "rmbg_adjust.py not found.";
                return;
            }

            var ts2     = String(new Date().getTime());
            var stPath  = TMP_DIR + "\\adj_status_" + ts2 + ".json";
            var logPath = TMP_DIR + "\\adj_log_"    + ts2 + ".txt";

            // Argomenti
            var expand  = Math.round(expSl.value  / 0.5) * 0.5;
            var blur    = Math.round(blurSl.value / 0.5) * 0.5;
            var invert  = invCb.value ? " --invert" : "";
            var argStr  = '--input "' + _previewOrigPath + '"' +
                          ' --output "' + _previewOutPath + '"' +
                          ' --mask_expand ' + expand.toFixed(1) +
                          ' --mask_blur '   + blur.toFixed(1) +
                          invert +
                          ' --status "' + stPath + '"';

            // .bat + VBS (stesso meccanismo del processo principale)
            ensureDir(TMP_DIR);
            var batPath2 = TMP_DIR + "\\adj_" + ts2 + ".bat";
            var bf2 = new File(batPath2);
            bf2.encoding = "UTF-8"; bf2.open("w");
            bf2.writeln("@echo off");
            bf2.writeln('"' + _previewPythonExe + '" "' + ADJUST_PY + '" ' + argStr +
                        ' >> "' + logPath + '" 2>&1');
            bf2.close();

            var vbsPath2 = TMP_DIR + "\\adj_vbs_" + ts2 + ".vbs";
            var bp2 = batPath2.replace(/\\/g, "\\\\");
            var vp2 = vbsPath2.replace(/\\/g, "\\\\");
            var vf2 = new File(vbsPath2);
            vf2.encoding = "UTF-8"; vf2.open("w");
            vf2.writeln('Set sh  = CreateObject("WScript.Shell")');
            vf2.writeln('Set fso = CreateObject("Scripting.FileSystemObject")');
            vf2.writeln('sh.Run "cmd /C """ & "' + bp2 + '" & """", 0, True');
            vf2.writeln('On Error Resume Next');
            vf2.writeln('fso.DeleteFile "' + bp2 + '"');
            vf2.writeln('fso.DeleteFile "' + vp2 + '"');
            vf2.close();
            new File(vbsPath2).execute();

            // Polling sul risultato (stesso pattern del job principale)
            $.global["__rmbg_adj_poll"] = function() { _pollAdjust(stPath, logPath); };
            app.scheduleTask("__rmbg_adj_poll()", 600, false);
        }

        function _pollAdjust(stPath, logPath) {
            var st = null;
            try {
                var f = new File(stPath);
                if (f.exists) {
                    f.encoding = "UTF-8"; f.open("r");
                    st = JSON.parse(f.read()); f.close();
                }
            } catch(e) {}

            if (!st) {
                $.global["__rmbg_adj_poll"] = function() { _pollAdjust(stPath, logPath); };
                app.scheduleTask("__rmbg_adj_poll()", 400, false);
                return;
            }

            if (st.status === "done") {
                try {
                    // Svuota la cache di AE e ricarica il footage dal disco
                    app.purge(PurgeTarget.ALL_CACHES);
                    _previewFootage.reload();
                } catch(e) {}
                previewLbl.text = "✓ Mask updated  (exp:" +
                    (Math.round(expSl.value/0.5)*0.5).toFixed(1) + "  blur:" + (Math.round(blurSl.value/0.5)*0.5).toFixed(1) + ")";
                try { new File(stPath).remove(); } catch(e) {}
                try { new File(logPath).remove(); } catch(e) {}
            } else if (st.status === "error") {
                previewLbl.text = "✗ Adjust error: " + (st.error || "");
                try { new File(stPath).remove(); } catch(e) {}
            } else {
                $.global["__rmbg_adj_poll"] = function() { _pollAdjust(stPath, logPath); };
                app.scheduleTask("__rmbg_adj_poll()", 400, false);
            }
        }

        win.add("panel",[0,0,0,1]);

        // Progress
        var progLbl = win.add("statictext",undefined,"Ready.",{multiline:true});
        progLbl.preferredSize=[300,30]; progLbl.alignment=["fill","top"];

        // Bottone
        var btnProc = win.add("button",undefined,"▶  Remove Background");
        btnProc.preferredSize.height=32;

        // Log
        var logPnl = win.add("panel",undefined,"Log");
        logPnl.alignment=["fill","fill"]; logPnl.alignChildren=["fill","fill"];
        var logBox = logPnl.add("edittext",undefined,"",{multiline:true,scrollable:true});
        logBox.preferredSize=[300,130];

        function p2(n){return n<10?"0"+n:String(n);}
        function ts(){var d=new Date();return p2(d.getHours())+":"+p2(d.getMinutes())+":"+p2(d.getSeconds());}
        function alog(msg){
            logBox.text=(logBox.text?logBox.text+"\n":"")+"["+ts()+"] "+msg;
            try{logBox.update();}catch(e){}
            // Auto-scroll to bottom
            try{logBox.scrollToView(logBox.text.length-1);}catch(e){}
            try{logBox.active=true; logBox.selection=[logBox.text.length,logBox.text.length];}catch(e){}
        }

        function setBusy(busy){
            btnProc.enabled=!busy;
            mDrop.enabled=!busy;
            cpInput.enabled=!busy;
            cpBtn.enabled=!busy;
        }

        btnProc.onClick = function() {
            refreshOutputPath();
            var cp = cpInput.text;
            if (!cp || !new Folder(cp).exists) {
                alert("Set the ComfyUI path first using the '…' button", NAME);
                return;
            }
            setBusy(true);
            // Reset stato preview — cancella _orig della sessione precedente
            if (_previewOrigPath && _previewOrigPath !== _previewOutPath) {
                try { new File(_previewOrigPath).remove(); } catch(e) {}
            }
            _previewFootage   = null;
            _previewOutPath   = null;
            _previewOrigPath  = null;
            _previewPythonExe = null;
            expSl.enabled  = false;
            blurSl.enabled = false;
            invCb.enabled  = false;
            previewLbl.text = "⏳ Processing…";
            progLbl.text = "⏳ Processing…  AE remains usable.";
            alog("=== Starting processing ===");

            startProcessing(
                {
                    model:       mDrop.selection.text,
                    maskExpand:  (Math.round(expSl.value  / 0.5) * 0.5),
                    maskBlur:    (Math.round(blurSl.value / 0.5) * 0.5),
                    invertMask:  invCb.value,
                    saveMatte:   matteCb.value,
                    comfyuiPath: cp
                },
                alog,
                function(footage, outPath, origPath, pythonExe, name, info) {
                    alog("✓  " + name + "  [" + info + "]");
                    progLbl.text = "✓ Done: " + name;
                    refreshOutputPath();
                    setBusy(false);
                    // Attiva gli slider per la preview
                    _previewFootage   = footage;
                    _previewOutPath   = outPath;
                    _previewOrigPath  = origPath;
                    _previewPythonExe = pythonExe;
                    expSl.enabled  = true;
                    blurSl.enabled = true;
                    invCb.enabled  = true;
                    previewLbl.text = "✓ Adjust sliders to update the mask.";
                },
                function(errMsg) {
                    alog("✗ ERROR:\n" + errMsg);
                    progLbl.text = "✗ Error — check log";
                    alert(errMsg, NAME);
                    setBusy(false);
                    _job = null;
                }
            );
        };

        win.add("statictext",undefined,
            "💡 Non serve avviare server. Python gira in background via GPU.",
            {multiline:true});

        if (win instanceof Window){win.center();win.show();}
        else {win.layout.layout(true);}
        return win;
    }

    buildUI(thisObj);

})(this);
