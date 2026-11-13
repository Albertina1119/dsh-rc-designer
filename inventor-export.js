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
  /* =====================================================================
   * iLogic 规则（VB.NET）
   *   为什么加这条：新版 Inventor 不再自带 VBA，Alt+F11 打不开。
   *   iLogic 用 .NET，不需要 VBA 组件，随 Inventor Professional 一起装。
   *   用法：iLogic 面板 → 添加规则 → 粘贴 → 运行。
   *   安全策略与 VBA 版一致：不打开/不保存/不删除任何文件；
   *   有任何文档打开就拒绝运行。
   * =================================================================== */
  function buildILogic(p) {
    const lv = 'iLogic';
    const L = [];
    const c = function (t) { return "' " + t; };

    L.push("' ============================================================");
    L.push(c('RC Aircraft Designer - iLogic rule (VB.NET)'));
    L.push(c('Project  : ' + asciiOnly(p.project)));
    L.push(c('Airfoil  : ' + asciiOnly(p.airfoilName)));
    L.push(c('Checksum : ' + asciiOnly(p.checksum || 'none')));
    L.push(c('Units    : mm / degrees'));
    L.push("' ============================================================");
    L.push("'");
    L.push(c('HOW TO RUN'));
    L.push(c('  1. Close ALL documents in Inventor (File > Close All)'));
    L.push(c('  2. Open the iLogic panel (Manage tab > iLogic)'));
    L.push(c('  3. Add Rule > paste this whole text > OK'));
    L.push(c('  4. Click Run'));
    L.push("'");
    L.push(c('WHAT IT DOES'));
    L.push(c('  Creates ONE new part with 6 airfoil sketches and 4 lofts.'));
    L.push("'");
    L.push(c('WHAT IT NEVER DOES'));
    L.push(c('  Never opens, saves, overwrites or deletes a file.'));
    L.push(c('  Refuses to run while any document is open.'));
    L.push("' ============================================================");
    L.push('');
    L.push("' ---- Dimensions (mm, degrees) ----");
    const K = [
      ['FUS_LEN', p.fuselageLength, 'fuselage length'],
      ['SEMI_SPAN', p.semiSpan, 'one side span'],
      ['ROOT_CHORD', p.rootChord, 'wing root chord'],
      ['TIP_CHORD', p.tipChord, 'wing tip chord'],
      ['DIHEDRAL', p.dihedral, 'dihedral'],
      ['SWEEP', p.sweep, 'sweep'],
      ['BODY_W', p.bodyMaxWidth, 'fuselage max width'],
      ['BODY_H', p.bodyMaxHeight, 'fuselage max height'],
      ['NOSE_LEN', p.noseLength, 'nose section'],
      ['WING_BAY', p.wingMountLength, 'wing bay'],
      ['HSTAB_SPAN', p.hStabSpan, 'horizontal tail span'],
      ['HSTAB_ROOT', p.hStabRootChord, 'horizontal tail root'],
      ['HSTAB_TIP', p.hStabTipChord, 'horizontal tail tip'],
      ['VSTAB_H', p.vStabHeight, 'vertical tail height'],
      ['VSTAB_ROOT', p.vStabRootChord, 'vertical tail root'],
      ['VSTAB_TIP', p.vStabTipChord, 'vertical tail tip'],
      ['VSTAB_SWEEP', p.vStabSweep, 'vertical tail sweep']
    ];
    K.forEach(function (x) { L.push('Const ' + x[0] + ' As Double = ' + fmtNum(x[1]) + '  \' ' + x[2]); });
    L.push('Const AIRFOIL As String = "' + asciiOnly(p.airfoilName) + '"');
    L.push('');

    // 翼型数组
    const pts = airfoilPoints(p);
    const xs = pts.map(function (q) { return fmtNum(q[0]); }).join(', ');
    const ys = pts.map(function (q) { return fmtNum(q[1]); }).join(', ');
    const wrap = function (str) {
      const parts = str.split(', ');
      const lines = [];
      let cur = '';
      parts.forEach(function (v, i) {
        cur += (i ? ', ' : '') + v;
        if (cur.length > 84) { lines.push(cur + ', _'); cur = ''; }
      });
      if (cur) lines.push(cur);
      return lines.join('\n        ');
    };
    L.push("' ---- Airfoil points (normalised: x 0 = LE, 1 = TE) ----");
    L.push('Dim AFX() As Double = { _');
    L.push('        ' + wrap(xs) + '}');
    L.push('Dim AFY() As Double = { _');
    L.push('        ' + wrap(ys) + '}');
    L.push('');
    L.push('Dim inv As Inventor.Application = ThisApplication');
    L.push('');
    L.push("' ---- SAFETY GATE: refuse while any document is open ----");
    L.push('If inv.Documents.Count > 0 Then');
    L.push('    MessageBox.Show("This rule refuses to run: " & inv.Documents.Count & _');
    L.push('        " document(s) are open in Inventor." & vbCrLf & vbCrLf & _');
    L.push('        "Close ALL documents first (File > Close All), then run again." & vbCrLf & vbCrLf & _');
    L.push('        "Why: the rule creates a new part. Requiring a clean session" & vbCrLf & _');
    L.push('        "is the only way to guarantee your own work is never affected.", _');
    L.push('        "RC Designer - safety guard")');
    L.push('Else');
    L.push('');
    L.push('    Dim oDoc As Inventor.PartDocument = Nothing');
    L.push('    Try');
    L.push('        oDoc = inv.Documents.Add( _');
    L.push('            Inventor.DocumentTypeEnum.kPartDocumentObject, _');
    L.push('            inv.FileManager.GetTemplateFile( _');
    L.push('                Inventor.DocumentTypeEnum.kPartDocumentObject), False)');
    L.push('        oDoc.UnitsOfMeasure.LengthUnits = Inventor.UnitsTypeEnum.kMillimeterLengthUnits');
    L.push('        oDoc.DisplayName = "RC_Part"');
    L.push('');
    L.push('        Dim cd As Inventor.PartComponentDefinition = oDoc.ComponentDefinition');
    L.push('        Dim tg As Inventor.TransientGeometry = inv.TransientGeometry');
    L.push('');
    L.push("        ' ---- find base planes by NORMAL, not by index ----");
    L.push('        Dim plSpan As Inventor.WorkPlane = PickPlane(cd, "Y")');
    L.push('        Dim plUp As Inventor.WorkPlane = PickPlane(cd, "Z")');
    L.push('        If plSpan Is Nothing Then');
    L.push('            MessageBox.Show("No base work plane with a Y normal was found.", "RC Designer")');
    L.push('            oDoc.Close(True)');
    L.push('            Return');
    L.push('        End If');
    L.push('');
    L.push('        Dim log As String = "Created 1 new part (invisible, unsaved)." & vbCrLf & vbCrLf');
    L.push('');
    L.push("        ' ---- wing root ----");
    L.push('        Dim s1 As Inventor.PlanarSketch = SketchAF(oDoc, plSpan, ROOT_CHORD, 0, 0)');
    L.push('        log = log & "[ok] wing root, chord " & ROOT_CHORD.ToString("0.0") & " mm" & vbCrLf');
    L.push('');
    L.push("        ' ---- wing tip ----");
    L.push('        Dim off As Inventor.WorkPlane = cd.WorkPlanes.AddByPlaneAndOffset(plSpan, SEMI_SPAN)');
    L.push('        off.Visible = False');
    L.push('        Dim dz As Double = SEMI_SPAN * Math.Tan(DIHEDRAL * Math.PI / 180)');
    L.push('        Dim dx As Double = SEMI_SPAN * Math.Tan(SWEEP * Math.PI / 180)');
    L.push('        Dim s2 As Inventor.PlanarSketch = SketchAF(oDoc, off, TIP_CHORD, dz, dx)');
    L.push('        log = log & "[ok] wing tip, chord " & TIP_CHORD.ToString("0.0") & " mm" & vbCrLf');
    L.push('        LoftTwo(cd, s1, s2)');
    L.push('        log = log & "[ok] wing loft" & vbCrLf');
    L.push('');
    L.push("        ' ---- horizontal tail ----");
    L.push('        Dim h1 As Inventor.PlanarSketch = SketchAF(oDoc, plSpan, HSTAB_ROOT, 0, 0)');
    L.push('        Dim hOff As Inventor.WorkPlane = cd.WorkPlanes.AddByPlaneAndOffset(plSpan, HSTAB_SPAN / 2)');
    L.push('        hOff.Visible = False');
    L.push('        Dim h2 As Inventor.PlanarSketch = SketchAF(oDoc, hOff, HSTAB_TIP, 0, 0)');
    L.push('        LoftTwo(cd, h1, h2)');
    L.push('        log = log & "[ok] horizontal tail" & vbCrLf');
    L.push('');
    L.push("        ' ---- vertical tail ----");
    L.push('        If plUp Is Nothing Then');
    L.push('            log = log & "[skip] no Z-normal plane: vertical tail skipped" & vbCrLf');
    L.push('        Else');
    L.push('            Dim v1 As Inventor.PlanarSketch = SketchAF(oDoc, plUp, VSTAB_ROOT, 0, 0)');
    L.push('            Dim vOff As Inventor.WorkPlane = cd.WorkPlanes.AddByPlaneAndOffset(plUp, VSTAB_H)');
    L.push('            vOff.Visible = False');
    L.push('            Dim vdz As Double = VSTAB_H * Math.Tan(VSTAB_SWEEP * Math.PI / 180)');
    L.push('            Dim v2 As Inventor.PlanarSketch = SketchAF(oDoc, vOff, VSTAB_TIP, 0, vdz)');
    L.push('            LoftTwo(cd, v1, v2)');
    L.push('            log = log & "[ok] vertical tail" & vbCrLf');
    L.push('        End If');
    L.push('');
    L.push('        oDoc.Visible = True');
    L.push('        log = log & vbCrLf & "Done: 1 part, 6 sketches, 3 lofts." & vbCrLf & _');
    L.push('               "Nothing was saved. Use File > Save As yourself."');
    L.push('        MessageBox.Show(log, "RC Designer - build finished")');
    L.push('');
    L.push('    Catch ex As Exception');
    L.push('        MessageBox.Show("Build stopped: " & ex.Message & vbCrLf & vbCrLf & _');
    L.push('            "Your existing files were never opened or modified.", _');
    L.push('            "RC Designer")');
    L.push("        ' close only the document this rule created");
    L.push('        If oDoc IsNot Nothing Then');
    L.push('            Try');
    L.push('                If Not oDoc.Dirty Then oDoc.Close(True)');
    L.push('            Catch');
    L.push('            End Try');
    L.push('        End If');
    L.push('    End Try');
    L.push('');
    L.push('End If');
    L.push('');
    L.push("' ---- helpers (iLogic supports local functions) ----");
    L.push("' Pick a base work plane by the direction of its normal.");
    L.push('Function PickPlane(cd As Inventor.PartComponentDefinition, ax As String) As Inventor.WorkPlane');
    L.push('    For i As Integer = 1 To 3');
    L.push('        Dim pl As Inventor.WorkPlane = cd.WorkPlanes.Item(i)');
    L.push('        Dim nv As Inventor.Vector = pl.Plane.Normal');
    L.push('        If ax = "X" AndAlso Math.Abs(nv.X) > 0.9 Then Return pl');
    L.push('        If ax = "Y" AndAlso Math.Abs(nv.Y) > 0.9 Then Return pl');
    L.push('        If ax = "Z" AndAlso Math.Abs(nv.Z) > 0.9 Then Return pl');
    L.push('    Next');
    L.push('    Return Nothing');
    L.push('End Function');
    L.push('');
    L.push("' Draw one closed airfoil outline on the given plane.");
    L.push('Function SketchAF(oDoc As Inventor.PartDocument, pl As Inventor.WorkPlane, _');
    L.push('                  chord As Double, yShift As Double, xShift As Double) As Inventor.PlanarSketch');
    L.push('    Dim tg As Inventor.TransientGeometry = ThisApplication.TransientGeometry');
    L.push('    Dim sk As Inventor.PlanarSketch = oDoc.ComponentDefinition.Sketches.Add(pl)');
    L.push('    Dim n As Integer = AFX.Length');
    L.push('    For i As Integer = 0 To n - 2');
    L.push('        sk.SketchLines.AddByTwoPoints( _');
    L.push('            tg.CreatePoint2d(xShift + AFX(i) * chord, yShift + AFY(i) * chord), _');
    L.push('            tg.CreatePoint2d(xShift + AFX(i + 1) * chord, yShift + AFY(i + 1) * chord))');
    L.push('    Next');
    L.push('    sk.SketchLines.AddByTwoPoints( _');
    L.push('        tg.CreatePoint2d(xShift + AFX(n - 1) * chord, yShift + AFY(n - 1) * chord), _');
    L.push('        tg.CreatePoint2d(xShift + AFX(0) * chord, yShift + AFY(0) * chord))');
    L.push('    Return sk');
    L.push('End Function');
    L.push('');
    L.push("' Loft between exactly two closed profiles.");
    L.push('Sub LoftTwo(cd As Inventor.PartComponentDefinition, _');
    L.push('            a As Inventor.PlanarSketch, b As Inventor.PlanarSketch)');
    L.push('    Dim path As Inventor.ProfilePath = cd.Sketches.CreateProfile');
    L.push('    path.Add(a.Profiles.Item(1))');
    L.push('    path.Add(b.Profiles.Item(1))');
    L.push('    Dim prof As Inventor.Profile = cd.Features.CreateProfile(path)');
    L.push('    cd.Features.LoftFeatures.Add(Inventor.PartFeatureOperationEnum.kJoinOperation, prof)');
    L.push('End Sub');
    return L.join('\r\n');
  }

  /** 把指南内容整理成结构化数据，供 Markdown 与 HTML 两种输出共用 */
  function guideData(p) {
    const f = function (v) {
      return typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—';
    };
    const dims = [
      ['翼展', f(p.fullSpan), 'tip to tip'],
      ['单侧半翼展', f(p.semiSpan), 'one side'],
      ['机翼根弦', f(p.rootChord), 'root chord'],
      ['机翼尖弦', f(p.tipChord), 'tip chord'],
      ['平均弦长', f(p.meanChord), 'S / b'],
      ['上反角 (°)', f(p.dihedral), 'dihedral'],
      ['后掠角 (°)', f(p.sweep), 'sweep'],
      ['机身总长', f(p.fuselageLength), 'fuselage length'],
      ['机身最大宽', f(p.bodyMaxWidth), 'max width'],
      ['机身最大高', f(p.bodyMaxHeight), 'max height'],
      ['机头段长', f(p.noseLength), 'nose'],
      ['机翼安装段长', f(p.wingMountLength), 'wing bay'],
      ['平尾翼展', f(p.hStabSpan), 'h-stab span'],
      ['平尾根弦', f(p.hStabRootChord), 'h-stab root'],
      ['平尾尖弦', f(p.hStabTipChord), 'h-stab tip'],
      ['垂尾高度', f(p.vStabHeight), 'v-stab height'],
      ['垂尾根弦', f(p.vStabRootChord), 'v-stab root'],
      ['垂尾尖弦', f(p.vStabTipChord), 'v-stab tip'],
      ['重心距机头', f(p.cgFromNose), 'CG from nose'],
      ['碳管主梁直径', f(p.sparDia), 'spar tube'],
      ['翼肋间距', f(p.ribSpacing), 'rib pitch']
    ];

    const wingTipShift = p.semiSpan * Math.tan(p.sweep * Math.PI / 180);
    const wingRise = p.semiSpan * Math.tan(p.dihedral * Math.PI / 180);
    const vTipShift = p.vStabHeight * Math.tan(p.vStabSweep * Math.PI / 180);

    const steps = [
      {
        title: '机翼',
        items: [
          '新建零件（.ipt），把单位改成<b>毫米</b>',
          '在 <b>XZ 平面</b>新建草图（该平面的法向是展向 Y）',
          '插入 → 导入 <code>airfoil_root.dxf</code>，缩放使弦长 = <b>' + f(p.rootChord) + ' mm</b>',
          '完成草图，重命名为 <code>wing_root</code>',
          '新建工作平面：以 XZ 平面为基准，偏移 <b>' + f(p.semiSpan) + ' mm</b>',
          '在该平面新建草图，导入 <code>airfoil_tip.dxf</code>，弦长 = <b>' + f(p.tipChord) + ' mm</b>',
          '尖截面沿弦向平移 <b>' + f(wingTipShift) + ' mm</b>（后掠）',
          '尖截面沿展向抬升 <b>' + f(wingRise) + ' mm</b>（上反）',
          '放样（Loft）：选两个草图 → 确定',
          '镜像到另一侧（关于 YZ 平面）'
        ]
      },
      {
        title: '机身',
        items: [
          '在 <b>XY 平面</b>新建草图',
          '机头端矩形：宽 <b>' + f(p.bodyMaxWidth * 0.3) + '</b> × 高 <b>' + f(p.bodyMaxHeight * 0.3) + '</b>',
          '偏移 <b>' + f(p.noseLength) + ' mm</b>，画最大截面：宽 <b>' + f(p.bodyMaxWidth) + '</b> × 高 <b>' + f(p.bodyMaxHeight) + '</b>',
          '再偏移 <b>' + f(p.noseLength + p.wingMountLength) + ' mm</b>，同一截面',
          '末端偏移 <b>' + f(p.fuselageLength) + ' mm</b>，尾部矩形：宽 <b>' + f(p.bodyMaxWidth * 0.28) + '</b> × 高 <b>' + f(p.bodyMaxHeight * 0.34) + '</b>',
          '放样四个截面'
        ]
      },
      {
        title: '平尾',
        items: [
          'XZ 平面画根截面，弦长 <b>' + f(p.hStabRootChord) + ' mm</b>',
          '偏移 <b>' + f(p.hStabSpan / 2) + ' mm</b> 画尖截面，弦长 <b>' + f(p.hStabTipChord) + ' mm</b>',
          '放样 → 镜像'
        ]
      },
      {
        title: '垂尾',
        items: [
          'XY 平面画根截面，弦长 <b>' + f(p.vStabRootChord) + ' mm</b>',
          '竖直偏移 <b>' + f(p.vStabHeight) + ' mm</b> 画尖截面，弦长 <b>' + f(p.vStabTipChord) + ' mm</b>',
          '沿弦向平移 <b>' + f(vTipShift) + ' mm</b>（后掠）',
          '放样'
        ]
      }
    ];

    const assembly = [
      ['机翼', '前缘距机头 ' + f(p.cgFromNose - p.mac * p.cgPctMac / 100) + ' mm，垂直居中'],
      ['平尾', '前缘距机头 ' + f(p.fuselageLength - p.hStabRootChord) + ' mm'],
      ['垂尾', '根弦前缘与平尾前缘对齐，贴机身上表面']
    ];

    return { f: f, dims: dims, steps: steps, assembly: assembly };
  }

  /** 手工建模指南（Markdown 版，供程序化使用） */
  function buildGuide(p) {
    const g = guideData(p);
    const L = [];
    L.push('# Inventor 手工建模步骤（零风险）');
    L.push('');
    L.push('> 这条路不运行任何宏、不连你的 Inventor。');
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
    L.push('## 关键尺寸（mm）');
    L.push('');
    L.push('| 参数 | 值 |');
    L.push('|---|---|');
    g.dims.forEach(function (d) { L.push('| ' + d[0] + ' | ' + d[1] + ' |'); });
    L.push('');
    const CN = ['二', '三', '四', '五', '六', '七'];
    g.steps.forEach(function (sec, si) {
      L.push('## ' + CN[si] + '、' + sec.title);
      L.push('');
      sec.items.forEach(function (it, ii) {
        L.push((ii + 1) + '. ' + it.replace(/<[^>]+>/g, ''));
      });
      L.push('');
    });
    L.push('## ' + CN[g.steps.length] + '、装配定位');
    L.push('');
    L.push('| 零件 | 定位 |');
    L.push('|---|---|');
    g.assembly.forEach(function (r) { L.push('| ' + r[0] + ' | ' + r[1] + ' |'); });
    L.push('');
    L.push('## ' + CN[g.steps.length + 1] + '、保存');
    L.push('');
    L.push('全部完成后由你自己另存。本工具不写任何文件。');
    L.push('');
    return L.join('\r\n');
  }

  /** 手工建模指南（HTML 版，双击即在浏览器打开，可打印） */
  function buildGuideHtml(p) {
    const g = guideData(p);
    const esc = function (t) {
      return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    const raw = function (t) { return String(t); };  // 已内含 <b>/<code>，原样输出

    const H = [];
    H.push('<!DOCTYPE html>');
    H.push('<html lang="zh-CN"><head><meta charset="utf-8">');
    H.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
    H.push('<title>' + esc(p.project) + ' · Inventor 建模步骤</title>');
    H.push('<style>');
    H.push('*{box-sizing:border-box}');
    H.push('body{margin:0;padding:28px 32px 64px;background:#f5f6f8;color:#1c2024;' +
      'font:15px/1.85 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}');
    H.push('.wrap{max-width:880px;margin:0 auto;background:#fff;border-radius:12px;' +
      'padding:36px 44px 44px;box-shadow:0 2px 20px rgba(0,0,0,.07)}');
    H.push('h1{margin:0 0 6px;font-size:25px;letter-spacing:-.4px}');
    H.push('.sub{color:#6b7480;font-size:13px;margin-bottom:26px}');
    H.push('h2{margin:34px 0 12px;font-size:17px;padding-bottom:8px;' +
      'border-bottom:2px solid #e8ecf1;color:#0d3b66}');
    H.push('table{width:100%;border-collapse:collapse;margin:10px 0 4px;font-size:14px}');
    H.push('th,td{padding:8px 12px;border:1px solid #e2e7ed;text-align:left}');
    H.push('th{background:#f0f4f8;font-weight:600;width:44%}');
    H.push('td.val{font-family:ui-monospace,Consolas,monospace;font-weight:600;color:#0b6b3a}');
    H.push('td.eng{color:#95a1ad;font-size:12.5px}');
    H.push('ol{padding-left:22px;margin:8px 0}');
    H.push('li{margin:5px 0}');
    H.push('b{color:#0d3b66}');
    H.push('code{background:#eef3f8;color:#0550a0;padding:1px 6px;border-radius:4px;' +
      'font-family:ui-monospace,Consolas,monospace;font-size:13px}');
    H.push('.safe{background:#eaf9f0;border:1px solid #a8e6c1;border-radius:9px;' +
      'padding:14px 18px;margin:22px 0;font-size:13.5px;line-height:1.9;color:#1a5c38}');
    H.push('.safe b{color:#0b6b3a}');
    H.push('.meta{display:flex;flex-wrap:wrap;gap:10px 28px;font-size:13.5px;' +
      'color:#4a5560;margin-bottom:4px}');
    H.push('.meta span b{color:#1c2024}');
    H.push('.print{position:fixed;right:22px;bottom:22px;background:#0d6efd;color:#fff;' +
      'border:none;border-radius:999px;padding:12px 22px;font-size:14px;cursor:pointer;' +
      'box-shadow:0 4px 16px rgba(13,110,253,.35)}');
    H.push('.print:hover{background:#0b5ed7}');
    H.push('@media print{body{background:#fff;padding:0}.wrap{box-shadow:none;padding:0}' +
      '.print{display:none}h2{page-break-after:avoid}}');
    H.push('</style></head><body><div class="wrap">');

    H.push('<h1>' + esc(p.project) + ' · Inventor 建模步骤</h1>');
    H.push('<div class="sub">' + esc(p.typeName || '') +
      '　翼型 ' + esc(p.airfoilName) +
      '　校验码 ' + esc(p.checksum || '—') + '</div>');

    H.push('<div class="safe"><b>这份文档不运行任何代码。</b><br>' +
      '跟着下面的数字在 Inventor 里操作即可。它不会连接、启动或控制 Inventor，' +
      '也不会读写你电脑上的任何文件。</div>');

    H.push('<h2>一、关键尺寸（全部为毫米）</h2>');
    H.push('<table><tr><th>参数</th><th>数值</th><th>English</th></tr>');
    g.dims.forEach(function (d) {
      H.push('<tr><th>' + esc(d[0]) + '</th><td class="val">' + esc(d[1]) +
        '</td><td class="eng">' + esc(d[2]) + '</td></tr>');
    });
    H.push('</table>');

    const CN = ['二', '三', '四', '五', '六'];
    g.steps.forEach(function (sec, si) {
      H.push('<h2>' + CN[si] + '、' + esc(sec.title) + '</h2><ol>');
      sec.items.forEach(function (it) {
        H.push('<li>' + raw(it) + '</li>');
      });
      H.push('</ol>');
    });

    H.push('<h2>' + CN[g.steps.length] + '、装配定位</h2>');
    H.push('<table><tr><th>零件</th><th>定位方式</th></tr>');
    g.assembly.forEach(function (r) {
      H.push('<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>');
    });
    H.push('</table>');

    H.push('<h2>' + CN[g.steps.length + 1] + '、保存</h2>');
    H.push('<p>全部完成后<b>由你自己</b>另存到想要的路径。本工具不写任何文件。</p>');

    H.push('</div>');
    H.push('<button class="print" onclick="window.print()">🖨 打印 / 存为 PDF</button>');
    H.push('</body></html>');
    return H.join('\r\n');
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
    buildGuideHtml: buildGuideHtml,
    buildILogic: buildILogic,
    guideData: guideData,
    paramsToJson: paramsToJson,
    airfoilDxf: airfoilDxf,
    asciiOnly: asciiOnly,
    defaultAirfoil: defaultAirfoil
  };
});
