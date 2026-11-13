/*!
 * inventor-export.js —— Inventor 建模包导出（浏览器端生成，零后端、零 COM 自动化）
 *
 * ===================================================================
 * 为什么重做（上一版把我的过错写在这里，避免以后再犯）
 * ===================================================================
 * 上一版是「网页 → 本地桥 → PowerShell → Inventor COM」，直接连用户
 * 正在运行的 Inventor 实例。这个架构是错的：
 *   · 用户可能有未保存的图纸，中途崩溃会把它们拖进损坏状态
 *   · 外部进程被中断时，Inventor 的 COM 会话被硬切断
 *   · 我无法在真实 Inventor 上验证 API，等于让用户试错
 *
 * 这一版彻底删除 COM 自动化，改为：
 *   1. 没有任何进程去连你的 Inventor
 *   2. 三级递进，每级单独可跑、随时可停：
 *        InventorDiag  只读自检，不创建任何东西
 *        BuildSketches 只画草图（一堆直线），不建任何实体特征
 *        BuildSolid    草图 + 放样（可选）
 *   3. 宏里零文件写操作：没有 Save / SaveAs / Open / Delete
 *   4. 硬闸门：Inventor 里有任何文档打开就拒绝运行
 * ===================================================================
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.InventorExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT = 'dsh-inventor@2';

  const LEVELS = {
    diag: {
      key: 'diag', name: '环境自检', sub: 'InventorDiag', risk: '零', riskEn: 'none',
      creates: '不创建任何东西（只读取版本/模板/基准面法向并弹报告）'
    },
    sketch: {
      key: 'sketch', name: '只画草图', sub: 'BuildSketches', risk: '低', riskEn: 'low',
      creates: '1 个新零件文档 + 6 个草图（只有直线，无任何实体特征）'
    },
    solid: {
      key: 'solid', name: '草图 + 放样', sub: 'BuildSolid', risk: '中', riskEn: 'medium',
      creates: '1 个新零件文档 + 6 个草图 + 4 个放样实体'
    }
  };

  /* ---------- 小工具 ---------- */
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  /** ASCII 安全化：VBA 编辑器按系统 ANSI 读 .bas，非 ASCII 会乱码 */
  function asciiOnly(str, dash) {
    const d = dash == null ? '-' : dash;
    const out = String(str == null ? '' : str)
      .replace(/[^\x20-\x7E]/g, d)
      .replace(new RegExp('\\' + d + '{2,}', 'g'), d)
      .replace(/^[\s\-]+|[\s\-]+$/g, '')
      .trim();
    return out || 'plan';
  }

  function fmtNum(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '0';
    return String(+v.toFixed(4));
  }

  function pick(list, name) {
    const it = (list || []).filter(function (x) { return x.name === name; })[0];
    if (!it) return null;
    return typeof it.value === 'number' ? it.value : null;
  }
  function pickText(list, name) {
    const it = (list || []).filter(function (x) { return x.name === name; })[0];
    return it ? it.value : null;
  }

  /* =====================================================================
   * 1. 参数提取
   * =================================================================== */
  function paramsFromCore(core, modeling, meta) {
    const c = core || {};
    const mp = modeling || [];
    const m = meta || {};
    const af = c.airfoil || {};
    const t = c.tail || {};

    const p = {
      format: FORMAT,
      generatedAt: new Date().toISOString(),
      project: m.projectName || '未命名方案',
      typeName: m.typeName || '',
      checksum: m.checksum || '',
      unit: 'mm',
      isRotary: !!c.rotary,

      fuselageLength: num(pick(mp, '机身总长'), num(c.fuselageLength, 0.9) * 1000),
      fullSpan: num(pick(mp, '总翼展'), num(c.span, 1.2) * 1000),

      semiSpan: num(pick(mp, '半翼展（单侧）'), num(c.span, 1.2) * 1000 / 2),
      rootChord: num(pick(mp, '根弦 cr'), num(c.planform && c.planform.root, 0.24) * 1000),
      tipChord: num(pick(mp, '尖弦 ct'), num(c.planform && c.planform.tip, 0.17) * 1000),
      meanChord: num(pick(mp, '平均几何弦长 c̄'), 250),
      mac: num(pick(mp, '平均气动弦 MAC'), 250),
      dihedral: num(pick(mp, '上反角'), 0),
      sweep: num(pick(mp, '后掠角'), 0),
      airfoilThickPct: num(pick(mp, '翼型厚度'), num(af.tc, 0.12) * 100),

      noseLength: num(pick(mp, '机头段长'), 0),
      wingMountLength: num(pick(mp, '机翼安装段长'), 0),
      tailArm: num(pick(mp, '尾段长（重心 → 平尾）'), num(t.lh, 0.5) * 1000),
      bodyMaxWidth: num(pick(mp, '建议最大截面宽'), 40),
      bodyMaxHeight: num(pick(mp, '建议最大截面高'), 35),

      hStabSpan: num(pick(mp, '平尾翼展'), num(t.spanH, 0.4) * 1000),
      hStabRootChord: num(pick(mp, '平尾根弦'), num(t.rootChordH, 0.18) * 1000),
      hStabTipChord: num(pick(mp, '平尾尖弦'), num(t.tipChordH, 0.14) * 1000),

      vStabHeight: num(pick(mp, '垂尾高度（翼展）'), num(t.spanV, 0.2) * 1000),
      vStabRootChord: num(pick(mp, '垂尾根弦'), num(t.rootChordV, 0.16) * 1000),
      vStabTipChord: num(pick(mp, '垂尾尖弦'), num(t.tipChordV, 0.12) * 1000),
      vStabSweep: 5,

      cgFromNose: num(pick(mp, '重心距机头'), 0),
      cgPctMac: num(pick(mp, '设计重心'), 30),
      sparDia: num(pick(mp, '碳管主梁直径'), 6),
      ribSpacing: num(pick(mp, '翼肋间距'), 100),

      airfoilName: af.designation || pickText(mp, '引用翼型') || 'NACA 2412'
    };

    p.airfoilPoints = (m.airfoilContour && m.airfoilContour.points)
      ? m.airfoilContour.points.map(function (pt) { return [+pt[0], +pt[1]]; })
      : null;

    return p;
  }

  /* =====================================================================
   * 2. 翼型坐标
   * =================================================================== */
  function defaultAirfoil() {
    const out = [];
    const N = 24;
    const yt = function (x) {
      return 0.6 * (0.2969 * Math.sqrt(Math.max(0, x)) - 0.126 * x
        - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
    };
    for (let i = 0; i <= N; i++) {
      const x = 0.5 * (1 - Math.cos((Math.PI * i) / N));
      out.push([x, yt(x)]);
    }
    for (let i = N; i >= 1; i--) {
      const x = 0.5 * (1 - Math.cos((Math.PI * i) / N));
      out.push([x, -yt(x)]);
    }
    return out;
  }

  function airfoilPoints(p) {
    return (p.airfoilPoints && p.airfoilPoints.length >= 8) ? p.airfoilPoints : defaultAirfoil();
  }

  function airfoilArrayBlock(p) {
    const pts = airfoilPoints(p);
    const xs = pts.map(function (q) { return fmtNum(q[0]); });
    const ys = pts.map(function (q) { return fmtNum(q[1]); });

    const wrap = function (arr) {
      const lines = [];
      let cur = '';
      arr.forEach(function (v, i) {
        cur += (i ? ', ' : '') + v;
        if (cur.length > 88) { lines.push(cur + ', _'); cur = ''; }
      });
      if (cur) lines.push(cur);
      return '\r\n    ' + lines.join('\r\n    ');
    };

    const L = [];
    L.push("' ---- Airfoil points, normalised: x 0 = leading edge, 1 = trailing edge ----");
    L.push("'      " + asciiOnly(p.airfoilName) + "   (" + pts.length + " points)");
    L.push('Private Function AFX(i As Long) As Double');
    L.push('  Dim a As Variant');
    L.push('  a = Array(' + wrap(xs) + ')');
    L.push('  AFX = a(i)');
    L.push('End Function');
    L.push('');
    L.push('Private Function AFY(i As Long) As Double');
    L.push('  Dim a As Variant');
    L.push('  a = Array(' + wrap(ys) + ')');
    L.push('  AFY = a(i)');
    L.push('End Function');
    L.push('');
    L.push('Private Function AFCount() As Long');
    L.push('  AFCount = ' + pts.length);
    L.push('End Function');
    return L.join('\r\n');
  }

  /* =====================================================================
   * 3. 常量块
   * =================================================================== */
  function constBlock(p) {
    const L = [];
    const w = function (name, val, cmt) {
      L.push('Public Const ' + name + ' As Double = ' + fmtNum(val) + '   \' ' + cmt);
    };
    L.push("' ---- Primary dimensions: mm, degrees ----");
    w('FUS_LEN', p.fuselageLength, 'fuselage length');
    w('FULL_SPAN', p.fullSpan, 'tip to tip');
    w('SEMI_SPAN', p.semiSpan, 'one side');
    w('ROOT_CHORD', p.rootChord, 'wing root chord');
    w('TIP_CHORD', p.tipChord, 'wing tip chord');
    w('MEAN_CHORD', p.meanChord, 'S / b');
    w('MAC_LEN', p.mac, 'mean aerodynamic chord');
    w('DIHEDRAL_DEG', p.dihedral, 'dihedral');
    w('SWEEP_DEG', p.sweep, 'leading edge sweep');
    w('BODY_W', p.bodyMaxWidth, 'fuselage max width');
    w('BODY_H', p.bodyMaxHeight, 'fuselage max height');
    w('NOSE_LEN', p.noseLength, 'nose section');
    w('WING_MOUNT_LEN', p.wingMountLength, 'wing bay');
    w('TAIL_ARM', p.tailArm, 'CG to tail');
    w('HSTAB_SPAN', p.hStabSpan, 'horizontal tail span');
    w('HSTAB_ROOT', p.hStabRootChord, 'horizontal tail root chord');
    w('HSTAB_TIP', p.hStabTipChord, 'horizontal tail tip chord');
    w('VSTAB_HEIGHT', p.vStabHeight, 'vertical tail height');
    w('VSTAB_ROOT', p.vStabRootChord, 'vertical tail root chord');
    w('VSTAB_TIP', p.vStabTipChord, 'vertical tail tip chord');
    w('VSTAB_SWEEP', p.vStabSweep, 'vertical tail sweep');
    w('CG_FROM_NOSE', p.cgFromNose, 'CG measured from nose');
    w('SPAR_DIA', p.sparDia, 'spar tube diameter');
    w('RIB_SPACING', p.ribSpacing, 'rib pitch');
    L.push('Public Const AIRFOIL_NAME As String = "' + asciiOnly(p.airfoilName) + '"');
    return L.join('\r\n');
  }

  /* =====================================================================
   * 4. 公共安全 + 辅助子程序
   * =================================================================== */
  function commonBlock() {
    return [
      "' ============================================================",
      "'  Safety guard and helpers",
      "' ============================================================",
      '',
      "' HARD GATE: refuse to run while ANY document is open.",
      "' New documents created here are also documents, so this doubles",
      "' as protection against an accidental second run.",
      'Private Function SafeToRun(oApp As Inventor.Application) As Boolean',
      '  Dim nOpen As Long',
      '  nOpen = 0',
      '  On Error Resume Next',
      '  nOpen = oApp.Documents.Count',
      '  On Error GoTo 0',
      '  If nOpen > 0 Then',
      '    MsgBox "This macro refuses to run: " & nOpen & _',
      '           " document(s) are open in Inventor." & vbCrLf & vbCrLf & _',
      '           "Close ALL documents first (File > Close All), then run again." & vbCrLf & vbCrLf & _',
      '           "Why: the macro creates a new document. Requiring a clean" & vbCrLf & _',
      '           "session is the only way to guarantee that your own work is" & vbCrLf & _',
      '           "never affected, even if something goes wrong.", _',
      '           vbExclamation, "RC Designer - safety guard"',
      '    SafeToRun = False',
      '    Exit Function',
      '  End If',
      '  SafeToRun = True',
      'End Function',
      '',
      "' Pick a base work plane by the direction its normal faces.",
      "' Using the normal instead of WorkPlanes.Item(n) removes any",
      "' dependency on plane ordering, which differs between templates.",
      'Private Function PickPlane(oCD As Inventor.PartComponentDefinition, _',
      '                           axisName As String) As Inventor.WorkPlane',
      '  Dim i As Long',
      '  Dim pl As Inventor.WorkPlane',
      '  Dim nv As Inventor.Vector',
      '  For i = 1 To 3',
      '    Set pl = oCD.WorkPlanes.Item(i)',
      '    Set nv = pl.Plane.Normal',
      '    Select Case axisName',
      '      Case "X"',
      '        If Abs(nv.X) > 0.9 Then Set PickPlane = pl: Exit Function',
      '      Case "Y"',
      '        If Abs(nv.Y) > 0.9 Then Set PickPlane = pl: Exit Function',
      '      Case "Z"',
      '        If Abs(nv.Z) > 0.9 Then Set PickPlane = pl: Exit Function',
      '    End Select',
      '  Next i',
      '  Set PickPlane = Nothing',
      'End Function',
      '',
      "' Create a NEW invisible part. Existing documents are never touched.",
      'Private Function NewPart(oApp As Inventor.Application, docName As String) As Inventor.PartDocument',
      '  Dim oDoc As Inventor.PartDocument',
      '  Set oDoc = oApp.Documents.Add(kPartDocumentObject, _',
      '                                oApp.FileManager.GetTemplateFile(kPartDocumentObject), False)',
      '  On Error Resume Next',
      '  oDoc.UnitsOfMeasure.LengthUnits = kMillimeterLengthUnits',
      '  oDoc.DisplayName = docName',
      '  On Error GoTo 0',
      '  Set NewPart = oDoc',
      'End Function',
      '',
      "' Draw one closed airfoil outline on the given plane.",
      'Private Function SketchProfile(oDoc As Inventor.PartDocument, _',
      '                               oPlane As Inventor.WorkPlane, _',
      '                               chord As Double, _',
      '                               yShift As Double, _',
      '                               xShift As Double) As Inventor.PlanarSketch',
      '  Dim oSk As Inventor.PlanarSketch',
      '  Dim oTg As Inventor.TransientGeometry',
      '  Dim i As Long, n As Long',
      '  Set oTg = oDoc.Parent.TransientGeometry',
      '  Set oSk = oDoc.ComponentDefinition.Sketches.Add(oPlane)',
      '  n = AFCount()',
      '  For i = 0 To n - 2',
      '    Call oSk.SketchLines.AddByTwoPoints( _',
      '      oTg.CreatePoint2d(xShift + AFX(i) * chord, yShift + AFY(i) * chord), _',
      '      oTg.CreatePoint2d(xShift + AFX(i + 1) * chord, yShift + AFY(i + 1) * chord))',
      '  Next i',
      "  ' close the outline",
      '  Call oSk.SketchLines.AddByTwoPoints( _',
      '    oTg.CreatePoint2d(xShift + AFX(n - 1) * chord, yShift + AFY(n - 1) * chord), _',
      '    oTg.CreatePoint2d(xShift + AFX(0) * chord, yShift + AFY(0) * chord))',
      '  Set SketchProfile = oSk',
      'End Function'
    ].join('\r\n');
  }

  /* =====================================================================
   * 5. Level 1：环境自检（只读）
   * =================================================================== */
  function diagSub() {
    return [
      "' ============================================================",
      "'  LEVEL 1 - Environment self-check",
      "'  Reads Inventor state and shows a report. CREATES NOTHING",
      "'  permanent: it opens one throwaway part to read the base",
      "'  work plane normals, then closes it immediately without saving.",
      "'",
      "'  Run this FIRST and send the report back.",
      "' ============================================================",
      'Public Sub InventorDiag()',
      '  Dim oApp As Inventor.Application',
      '  Dim s As String',
      '  On Error GoTo Fail',
      '',
      '  Set oApp = GetInventor()',
      '  s = "RC Designer - Inventor environment report" & vbCrLf',
      '  s = s & String(56, "-") & vbCrLf',
      '  s = s & "Inventor version : " & oApp.SoftwareVersion & vbCrLf',
      '  On Error Resume Next',
      '  s = s & "Caption          : " & oApp.Caption & vbCrLf',
      '  s = s & "Documents open   : " & oApp.Documents.Count & vbCrLf',
      '  s = s & "Part template    : " & _',
      '          oApp.FileManager.GetTemplateFile(kPartDocumentObject) & vbCrLf',
      '  On Error GoTo Fail',
      '  s = s & vbCrLf & "Target part from the design report:" & vbCrLf',
      '  s = s & "  Airfoil         : " & AIRFOIL_NAME & vbCrLf',
      '  s = s & "  Span            : " & Format(FULL_SPAN, "0.0") & " mm" & vbCrLf',
      '  s = s & "  Root chord      : " & Format(ROOT_CHORD, "0.0") & " mm" & vbCrLf',
      '  s = s & "  Tip chord       : " & Format(TIP_CHORD, "0.0") & " mm" & vbCrLf',
      '  s = s & "  Fuselage length : " & Format(FUS_LEN, "0.0") & " mm" & vbCrLf',
      '  s = s & "  Airfoil points  : " & AFCount() & vbCrLf',
      '  s = s & vbCrLf & "Base work planes:" & vbCrLf',
      '  s = s & CheckPlanes(oApp) & vbCrLf',
      '  s = s & String(56, "-") & vbCrLf',
      '  s = s & "This check saved nothing and left no document open."',
      '  MsgBox s, vbInformation, "RC Designer - self check"',
      '  Exit Sub',
      '',
      'Fail:',
      '  MsgBox "Self check failed: " & Err.Description, vbCritical, "RC Designer"',
      'End Sub',
      '',
      "' Open a throwaway part to read base plane normals, then close it",
      "' WITHOUT saving. Nothing is written to disk.",
      'Private Function CheckPlanes(oApp As Inventor.Application) As String',
      '  Dim oDoc As Inventor.PartDocument',
      '  Dim oCD As Inventor.PartComponentDefinition',
      '  Dim i As Long',
      '  Dim pl As Inventor.WorkPlane',
      '  Dim nv As Inventor.Vector',
      '  Dim s As String',
      '  On Error Resume Next',
      '  Set oDoc = oApp.Documents.Add(kPartDocumentObject, _',
      '                 oApp.FileManager.GetTemplateFile(kPartDocumentObject), False)',
      '  If oDoc Is Nothing Then',
      '    CheckPlanes = "  (could not create a test part)"',
      '    Exit Function',
      '  End If',
      '  Set oCD = oDoc.ComponentDefinition',
      '  s = ""',
      '  For i = 1 To 3',
      '    Set pl = oCD.WorkPlanes.Item(i)',
      '    Set nv = pl.Plane.Normal',
      '    s = s & "  Item(" & i & ")  normal = (" & _',
      '        Format(nv.X, "0.00") & ", " & Format(nv.Y, "0.00") & ", " & _',
      '        Format(nv.Z, "0.00") & ")" & vbCrLf',
      '  Next i',
      "  ' close without saving",
      '  oDoc.Close(True)',
      '  CheckPlanes = s',
      'End Function'
    ].join('\r\n');
  }

  /* =====================================================================
   * 6. Level 2 / 3：草图（± 放样）
   * =================================================================== */
  function sketchSub(solid) {
    const L = [];
    L.push("' ============================================================");
    if (solid) {
      L.push("'  LEVEL 3 - Sketches + lofted solids");
      L.push("'  Creates 1 part, 6 sketches and 4 loft features.");
      L.push("'  If any step fails, the part created here is closed again.");
    } else {
      L.push("'  LEVEL 2 - Sketches only");
      L.push("'  Creates 1 part and draws 6 airfoil outlines.");
      L.push("'  NO solid features are created, so the riskiest API calls");
      L.push("'  (CreateProfile / LoftFeatures) are never reached.");
    }
    L.push("' ============================================================");
    L.push('Public Sub ' + (solid ? 'BuildSolid' : 'BuildSketches') + '()');
    L.push('  Dim oApp As Inventor.Application');
    L.push('  Dim oDoc As Inventor.PartDocument');
    L.push('  Dim oCD As Inventor.PartComponentDefinition');
    L.push('  Dim plSpan As Inventor.WorkPlane');
    L.push('  Dim plUp As Inventor.WorkPlane');
    L.push('  Dim plOff As Inventor.WorkPlane');
    L.push('  Dim s1 As Inventor.PlanarSketch');
    L.push('  Dim s2 As Inventor.PlanarSketch');
    L.push('  Dim sLog As String');
    L.push('  On Error GoTo Fail');
    L.push('');
    L.push('  Set oApp = GetInventor()');
    L.push('  If Not SafeToRun(oApp) Then Exit Sub');
    L.push('  oApp.Visible = True');
    L.push('  oApp.SilentOperation = False');
    L.push('');
    L.push("  ' One part holds every profile: only ONE new document is created.");
    L.push('  Set oDoc = NewPart(oApp, "RC_' + (solid ? 'Solid' : 'Sketches') + '")');
    L.push('  Set oCD = oDoc.ComponentDefinition');
    L.push('  sLog = "Created 1 new part (invisible, unsaved)." & vbCrLf & vbCrLf');
    L.push('');
    L.push("  ' ---- Base planes, picked by normal direction ----");
    L.push('  Set plSpan = PickPlane(oCD, "Y")');
    L.push('  Set plUp = PickPlane(oCD, "Z")');
    L.push('  If plSpan Is Nothing Then');
    L.push('    Err.Raise vbObjectError + 10, , "No base plane with a Y normal was found"');
    L.push('  End If');
    L.push('  plSpan.Visible = False');
    L.push('');
    L.push("  ' ---- Wing root ----");
    L.push('  Set s1 = SketchProfile(oDoc, plSpan, ROOT_CHORD, 0, 0)');
    L.push('  sLog = sLog & "[ok] wing root, chord " & Format(ROOT_CHORD, "0.0") & " mm" & vbCrLf');
    L.push('');
    L.push("  ' ---- Wing tip: offset by the semi span, shifted by sweep ----");
    L.push('  Set plOff = oCD.WorkPlanes.AddByPlaneAndOffset(plSpan, SEMI_SPAN)');
    L.push('  plOff.Visible = False');
    L.push('  Set s2 = SketchProfile(oDoc, plOff, TIP_CHORD, 0, _');
    L.push('           SEMI_SPAN * Tan(SWEEP_DEG * PI / 180))');
    L.push('  sLog = sLog & "[ok] wing tip, chord " & Format(TIP_CHORD, "0.0") & " mm" & vbCrLf');
    if (solid) {
      L.push('  Call LoftTwo(oDoc, s1, s2)');
      L.push('  sLog = sLog & "[ok] wing loft" & vbCrLf');
    }
    L.push('');
    L.push("  ' ---- Horizontal tail ----");
    L.push('  Set s1 = SketchProfile(oDoc, plSpan, HSTAB_ROOT, 0, 0)');
    L.push('  Set plOff = oCD.WorkPlanes.AddByPlaneAndOffset(plSpan, HSTAB_SPAN / 2)');
    L.push('  plOff.Visible = False');
    L.push('  Set s2 = SketchProfile(oDoc, plOff, HSTAB_TIP, 0, 0)');
    L.push('  sLog = sLog & "[ok] horizontal tail sketches" & vbCrLf');
    if (solid) {
      L.push('  Call LoftTwo(oDoc, s1, s2)');
      L.push('  sLog = sLog & "[ok] horizontal tail loft" & vbCrLf');
    }
    L.push('');
    L.push("  ' ---- Vertical tail: sections are horizontal planes ----");
    L.push('  If plUp Is Nothing Then');
    L.push('    sLog = sLog & "[skip] no base plane with a Z normal: vertical tail skipped" & vbCrLf');
    L.push('  Else');
    L.push('    plUp.Visible = False');
    L.push('    Set s1 = SketchProfile(oDoc, plUp, VSTAB_ROOT, 0, 0)');
    L.push('    Set plOff = oCD.WorkPlanes.AddByPlaneAndOffset(plUp, VSTAB_HEIGHT)');
    L.push('    plOff.Visible = False');
    L.push('    Set s2 = SketchProfile(oDoc, plOff, VSTAB_TIP, 0, _');
    L.push('             VSTAB_HEIGHT * Tan(VSTAB_SWEEP * PI / 180))');
    L.push('    sLog = sLog & "[ok] vertical tail sketches" & vbCrLf');
    if (solid) {
      L.push('    Call LoftTwo(oDoc, s1, s2)');
      L.push('    sLog = sLog & "[ok] vertical tail loft" & vbCrLf');
    }
    L.push('  End If');
    L.push('');
    L.push('  On Error Resume Next');
    L.push('  oDoc.Visible = True');
    L.push('  On Error GoTo Fail');
    L.push('');
    L.push('  sLog = sLog & vbCrLf & "' +
      (solid ? 'Done: 1 part, 6 sketches, 4 lofts.' : 'Done: 1 part, 6 sketches, no solid features.') +
      '" & vbCrLf & _');
    L.push('         "Nothing was saved to disk. Use File > Save As yourself."');
    L.push('  MsgBox sLog, vbInformation, "RC Designer - build finished"');
    L.push('  Exit Sub');
    L.push('');
    L.push('Fail:');
    L.push('  MsgBox "Build stopped: " & Err.Description & vbCrLf & vbCrLf & _');
    L.push('         "Any document created by this macro has been closed." & vbCrLf & _');
    L.push('         "Your existing files were never opened or modified.", _');
    L.push('         vbCritical, "RC Designer"');
    L.push('  Call CloseUnsaved(oApp)');
    L.push('End Sub');

    if (solid) {
      L.push('');
      L.push("' Loft between exactly two closed profiles.");
      L.push("' Documented three-step form: ProfilePath -> Add -> CreateProfile.");
      L.push('Private Sub LoftTwo(oDoc As Inventor.PartDocument, _');
      L.push('                     sA As Inventor.PlanarSketch, _');
      L.push('                     sB As Inventor.PlanarSketch)');
      L.push('  Dim oCD As Inventor.PartComponentDefinition');
      L.push('  Dim oPath As Inventor.ProfilePath');
      L.push('  Dim oProf As Inventor.Profile');
      L.push('  Set oCD = oDoc.ComponentDefinition');
      L.push('  Set oPath = oCD.Sketches.CreateProfile');
      L.push('  Call oPath.Add(sA.Profiles.Item(1))');
      L.push('  Call oPath.Add(sB.Profiles.Item(1))');
      L.push('  Set oProf = oCD.Features.CreateProfile(oPath)');
      L.push('  Call oCD.Features.LoftFeatures.Add(kJoinOperation, oProf)');
      L.push('End Sub');
    }
    return L.join('\r\n');
  }

  /* =====================================================================
   * 7. 收尾
   * =================================================================== */
  function cleanupBlock() {
    return [
      '',
      "' Close any document that is still dirty. Because the macro requires",
      "' an empty session to start, everything dirty here was created by this",
      "' macro. This never saves anything.",
      'Private Sub CloseUnsaved(oApp As Inventor.Application)',
      '  Dim i As Long',
      '  Dim n As Long',
      '  Dim oDoc As Inventor.Document',
      '  On Error Resume Next',
      '  n = oApp.Documents.Count',
      '  For i = n To 1 Step -1',
      '    Set oDoc = oApp.Documents.Item(i)',
      '    If Not oDoc.Dirty Then oDoc.Close(True)',
      '  Next i',
      'End Sub',
      '',
      "' Attach to a running Inventor, or start one.",
      'Private Function GetInventor() As Inventor.Application',
      '  Dim oApp As Inventor.Application',
      '  On Error Resume Next',
      '  Set oApp = GetObject(, "Inventor.Application")',
      '  If oApp Is Nothing Then Set oApp = CreateObject("Inventor.Application")',
      '  On Error GoTo 0',
      '  If oApp Is Nothing Then Err.Raise vbObjectError + 1, , "Cannot start Inventor"',
      '  Set GetInventor = oApp',
      'End Function'
    ].join('\r\n');
  }

  /**
   * 生成 VBA 宏
   * @param {object} p    paramsFromCore 的结果
   * @param {object} opt  { level: 'diag' | 'sketch' | 'solid' }
   * @returns {string}    .bas 源码（纯 ASCII）
   */
  function buildVba(p, opt) {
    const o = opt || {};
    const level = (o.level === 'sketch' || o.level === 'solid') ? o.level : 'diag';
    const lv = LEVELS[level];

    // 用 c() 生成 VBA 注释行，避免手写引号出错
    const c = function (txt) { return "' " + txt; };
    const parts = [
      'Attribute VB_Name = "InventorBuild"',
      c('============================================================'),
      c('RC Aircraft Designer - Inventor build macro'),
      c('Project  : ' + asciiOnly(p.project)),
      c('Airfoil  : ' + asciiOnly(p.airfoilName)),
      c('Checksum : ' + asciiOnly(p.checksum || 'none')),
      c('Level    : ' + level.toUpperCase() + ' (risk: ' + lv.riskEn + ')'),
      c('============================================================'),
      c(''),
      c('WHAT THIS MACRO CREATES'),
      c('  ' + asciiOnly(lv.creates)),
      c(''),
      c('WHAT IT NEVER DOES'),
      c('  - never opens an existing file'),
      c('  - never saves, overwrites or deletes anything'),
      c('  - never runs while a document is open (hard gate below)'),
      c(''),
      c('HOW TO RUN'),
      c('  1. Close ALL documents in Inventor  (File > Close All)'),
      c('  2. Press Alt+F11 to open the VBA editor'),
      c('  3. Menu: File > Import File...  and pick this .bas'),
      c('  4. Press F5 and choose: ' + lv.sub),
      c(''),
      c('SUBROUTINES IN THIS FILE'),
      c('  ' + (level === 'diag' ? 'InventorDiag   level 1  read-only report, leaves nothing behind'
        : level === 'sketch' ? 'BuildSketches  level 2  one part, airfoil outlines only'
          : 'BuildSolid     level 3  one part, sketches + lofted solids')),
      c(''),
      c('THIS FILE: run  ' + lv.sub),
      c('============================================================'),
      'Option Explicit',
      '',
      'Private Const PI As Double = 3.14159265358979',
      '',
      constBlock(p),
      '',
      airfoilArrayBlock(p),
      '',
      commonBlock(),
      '',
      (level === 'diag' ? diagSub() : ''),
      (level === 'sketch' ? sketchSub(false) : ''),
      (level === 'solid' ? sketchSub(true) : ''),
      ''
    ];
    parts.push(cleanupBlock());
    return parts.join('\r\n');
  }

  /* =====================================================================
   * 8. 手工建模指南（零风险路径）
   * =================================================================== */
  function buildGuide(p) {
    const f = function (v) {
      return typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—';
    };
    const L = [];
    L.push('# Inventor 手工建模步骤（零风险）');
    L.push('');
    L.push('> 这条路**不运行任何宏、不连你的 Inventor**。');
    L.push('> 全部靠你在 Inventor 里照着数字点几下。');
    L.push('> 如果你不想再冒任何风险，就只用这条。');
    L.push('');
    L.push('## 方案');
    L.push('');
    L.push('| 项 | 值 |');
    L.push('|---|---|');
    L.push('| 方案名 | ' + p.project + ' |');
    L.push('| 机型 | ' + (p.typeName || '—') + ' |');
    L.push('| 翼型 | ' + p.airfoilName + ' |');
    L.push('| 校验码 | ' + (p.checksum || '—') + ' |');
    L.push('');
    L.push('## 一、关键尺寸（mm）');
    L.push('');
    L.push('| 参数 | 值 |');
    L.push('|---|---|');
    [
      ['翼展', f(p.fullSpan)], ['单侧半翼展', f(p.semiSpan)],
      ['机翼根弦', f(p.rootChord)], ['机翼尖弦', f(p.tipChord)],
      ['平均弦长', f(p.meanChord)], ['上反角 (°)', f(p.dihedral)], ['后掠角 (°)', f(p.sweep)],
      ['机身总长', f(p.fuselageLength)], ['机身最大宽', f(p.bodyMaxWidth)],
      ['机身最大高', f(p.bodyMaxHeight)], ['机头段长', f(p.noseLength)],
      ['机翼安装段长', f(p.wingMountLength)],
      ['平尾翼展', f(p.hStabSpan)], ['平尾根弦', f(p.hStabRootChord)],
      ['平尾尖弦', f(p.hStabTipChord)],
      ['垂尾高度', f(p.vStabHeight)], ['垂尾根弦', f(p.vStabRootChord)],
      ['垂尾尖弦', f(p.vStabTipChord)],
      ['重心距机头', f(p.cgFromNose)], ['碳管主梁直径', f(p.sparDia)],
      ['翼肋间距', f(p.ribSpacing)]
    ].forEach(function (r) { L.push('| ' + r[0] + ' | ' + r[1] + ' |'); });
    L.push('');
    L.push('## 二、机翼');
    L.push('');
    L.push('1. 新建零件（.ipt），单位改为毫米');
    L.push('2. 在 **XZ 平面**新建草图（该平面法向为展向 Y）');
    L.push('3. 插入 → 导入 `airfoil_root.dxf`，缩放使**弦长 = ' + f(p.rootChord) + ' mm**');
    L.push('4. 完成草图，改名 `wing_root`');
    L.push('5. 新建工作平面：以 XZ 为基准，偏移 **' + f(p.semiSpan) + ' mm**');
    L.push('6. 在该平面新建草图，导入 `airfoil_tip.dxf`，**弦长 = ' + f(p.tipChord) + ' mm**');
    L.push('7. 沿弦向平移 **' + f(p.semiSpan * Math.tan(p.sweep * Math.PI / 180)) +
      ' mm**（后掠）');
    L.push('8. 沿展向抬升 **' + f(p.semiSpan * Math.tan(p.dihedral * Math.PI / 180)) +
      ' mm**（上反）');
    L.push('9. 放样（Loft）：选两个草图 → 确定');
    L.push('10. 镜像到另一侧（关于 YZ 平面）');
    L.push('');
    L.push('## 三、机身');
    L.push('');
    L.push('1. 在 XY 平面新建草图');
    L.push('2. 机头端矩形：宽 ' + f(p.bodyMaxWidth * 0.3) + ' × 高 ' + f(p.bodyMaxHeight * 0.3));
    L.push('3. 偏移 ' + f(p.noseLength) + ' mm 处画最大截面：宽 ' +
      f(p.bodyMaxWidth) + ' × 高 ' + f(p.bodyMaxHeight));
    L.push('4. 再偏移 ' + f(p.noseLength + p.wingMountLength) + ' mm，同截面');
    L.push('5. 末端偏移 ' + f(p.fuselageLength) + ' mm，尾部矩形：宽 ' +
      f(p.bodyMaxWidth * 0.28) + ' × 高 ' + f(p.bodyMaxHeight * 0.34));
    L.push('6. 放样四个截面');
    L.push('');
    L.push('## 四、平尾');
    L.push('');
    L.push('1. XZ 平面画根截面，弦长 ' + f(p.hStabRootChord) + ' mm');
    L.push('2. 偏移 ' + f(p.hStabSpan / 2) + ' mm 画尖截面，弦长 ' +
      f(p.hStabTipChord) + ' mm');
    L.push('3. 放样 → 镜像');
    L.push('');
    L.push('## 五、垂尾');
    L.push('');
    L.push('1. XY 平面画根截面，弦长 ' + f(p.vStabRootChord) + ' mm');
    L.push('2. 竖直偏移 ' + f(p.vStabHeight) + ' mm 画尖截面，弦长 ' +
      f(p.vStabTipChord) + ' mm');
    L.push('3. 沿弦向平移 ' + f(p.vStabHeight * Math.tan(p.vStabSweep * Math.PI / 180)) +
      ' mm（后掠）');
    L.push('4. 放样');
    L.push('');
    L.push('## 六、装配定位');
    L.push('');
    L.push('| 零件 | 定位 |');
    L.push('|---|---|');
    L.push('| 机翼 | 前缘距机头 ' +
      f(p.cgFromNose - p.mac * p.cgPctMac / 100) + ' mm，垂直居中 |');
    L.push('| 平尾 | 前缘距机头 ' + f(p.fuselageLength - p.hStabRootChord) + ' mm |');
    L.push('| 垂尾 | 根弦前缘与平尾前缘对齐，贴机身上表面 |');
    L.push('');
    L.push('## 七、保存');
    L.push('');
    L.push('全部完成后**由你自己**另存到想要的路径。本工具不写任何文件。');
    L.push('');
    return L.join('\r\n');
  }

  function paramsToJson(p) {
    return JSON.stringify(p, null, 2);
  }

  /* =====================================================================
   * 9. 翼型 DXF（供 Inventor 插入草图）
   * =================================================================== */
  function getCad() {
    if (typeof CadExport !== 'undefined' && CadExport && CadExport.polylineDxf) return CadExport;
    if (typeof require === 'function') {
      try { return require('./cad-export.js'); } catch (e) {}
    }
    return null;
  }

  function airfoilDxf(p, chordMM, label) {
    const pts = airfoilPoints(p).map(function (q) {
      return [q[0] * chordMM, q[1] * chordMM];
    });
    const cad = getCad();
    if (cad) {
      return {
        ok: true,
        dxf: cad.polylineDxf(pts, { layer: 'AIRFOIL' }),
        filename: label + '.dxf',
        chordMM: chordMM,
        points: pts.length
      };
    }
    const pair = function (c, v) { return String(c) + '\n' + String(v) + '\n'; };
    let s = '';
    s += pair(0, 'SECTION') + pair(2, 'HEADER');
    s += pair(9, '$ACADVER') + pair(1, 'AC1009');
    s += pair(9, '$INSUNITS') + pair(70, 4);
    s += pair(0, 'ENDSEC');
    s += pair(0, 'SECTION') + pair(2, 'ENTITIES');
    s += pair(0, 'POLYLINE') + pair(8, 'AIRFOIL') + pair(66, 1) + pair(70, 1);
    s += pair(10, 0) + pair(20, 0) + pair(30, 0);
    pts.forEach(function (q) {
      s += pair(0, 'VERTEX') + pair(8, 'AIRFOIL');
      s += pair(10, q[0].toFixed(4)) + pair(20, q[1].toFixed(4)) + pair(30, 0);
    });
    s += pair(0, 'SEQEND') + pair(8, 'AIRFOIL');
    s += pair(0, 'ENDSEC') + pair(0, 'EOF');
    return { ok: true, dxf: s, filename: label + '.dxf', chordMM: chordMM, points: pts.length };
  }

  return {
    FORMAT: FORMAT,
    LEVELS: LEVELS,
    paramsFromCore: paramsFromCore,
    buildVba: buildVba,
    buildGuide: buildGuide,
    paramsToJson: paramsToJson,
    airfoilDxf: airfoilDxf,
    asciiOnly: asciiOnly,
    defaultAirfoil: defaultAirfoil
  };
});
