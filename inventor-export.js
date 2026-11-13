/*!
 * inventor-export.js —— Inventor 自动建模导出（浏览器端生成，零后端）
 *
 * 为什么需要它：
 *   浏览器出于安全限制，无法直接启动或控制桌面程序（Inventor 是 Windows 桌面应用）。
 *   所以"让网站直接操作 Inventor"必须落地成本地能执行的东西。本模块提供两条路：
 *
 *   路径 A（零安装，推荐先用）
 *     导出 InventorBuild.bas（VBA 宏）+ inventor_params.json
 *     在 Inventor 里 Alt+F11 → 导入 .bas → 运行 BuildModel → 自动生成模型
 *
 *   路径 B（一键，需启动本地桥）
 *     配合 inventor-bridge/ 本地桥，网页上点「直接建模」，桥调用 Inventor COM 建模
 *
 * 两条路径共用同一套参数（paramsFromCore），保证结果一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.InventorExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT = 'dsh-inventor@1';

  /* =====================================================================
   * 1. 从引擎建模参数提取「可建模」的扁平参数集
   * =================================================================== */

  /** 从 modelingParams 的 [{group,name,value,unit,note}] 里按名字取值（数字） */
  function pick(list, name) {
    const it = (list || []).filter(function (x) { return x.name === name; })[0];
    if (!it) return null;
    return typeof it.value === 'number' ? it.value : null;
  }
  function pickText(list, name) {
    const it = (list || []).filter(function (x) { return x.name === name; })[0];
    return it ? it.value : null;
  }

  /**
   * 生成 Inventor 参数集（全部 mm / 度）
   * @param {object} core       引擎 core
   * @param {Array}  modeling   modelingParams()
   * @param {object} meta       { projectName, typeName, checksum, airfoil }
   */
  function paramsFromCore(core, modeling, meta) {
    const c = core || {};
    const mp = modeling || [];
    const m = meta || {};
    const num = function (v, d) { return typeof v === 'number' && isFinite(v) ? v : d; };

    const isRotary = !!c.rotary;
    const af = c.airfoil || {};
    const t = c.tail || {};

    const p = {
      format: FORMAT,
      generatedAt: new Date().toISOString(),
      project: m.projectName || '未命名方案',
      typeName: m.typeName || '',
      checksum: m.checksum || '',
      unit: 'mm',
      // ---- 基准 ----
      fuselageLength: num(pick(mp, '机身总长'), num(c.fuselageLength, 0.9) * 1000),
      fullSpan: num(pick(mp, '总翼展'), num(c.span, 1.2) * 1000),
      fullHeight: num(pick(mp, '全机高度'), 200),
      // ---- 机翼 ----
      semiSpan: num(pick(mp, '半翼展（单侧）'), num(c.span, 1.2) * 1000 / 2),
      rootChord: num(pick(mp, '根弦 cr'), num(c.planform && c.planform.root, 0.24) * 1000),
      tipChord: num(pick(mp, '尖弦 ct'), num(c.planform && c.planform.tip, 0.17) * 1000),
      meanChord: num(pick(mp, '平均几何弦长 c̄'), 250),
      mac: num(pick(mp, '平均气动弦 MAC'), 250),
      macY: num(pick(mp, 'MAC 展向位置'), 0),
      dihedral: num(pick(mp, '上反角'), 0),
      sweep: num(pick(mp, '后掠角'), 0),
      twist: num(pick(mp, '扭转角（翼尖）'), 0),
      airfoilThickPct: num(pick(mp, '翼型厚度'), num(af.tc, 0.12) * 100),
      airfoilCamberPct: num(pick(mp, '翼型最大弯度'), num(af.camber, 0.02) * 100),
      maxThickness: num(pick(mp, '最大厚度（绝对值）'), 40),
      // ---- 副翼 ----
      aileronChord: num(pick(mp, '副翼弦长'), 0),
      aileronStart: num(pick(mp, '展向起点（距对称面）'), 0),
      aileronEnd: num(pick(mp, '展向终点（距对称面）'), 0),
      // ---- 机身 ----
      noseLength: num(pick(mp, '机头段长'), 0),
      wingMountLength: num(pick(mp, '机翼安装段长'), 0),
      tailArm: num(pick(mp, '尾段长（重心 → 平尾）'), num(t.lh, 0.5) * 1000),
      bodyMaxWidth: num(pick(mp, '建议最大截面宽'), 40),
      bodyMaxHeight: num(pick(mp, '建议最大截面高'), 35),
      // ---- 平尾 ----
      hStabSpan: num(pick(mp, '平尾翼展'), num(t.spanH, 0.4) * 1000),
      hStabRootChord: num(pick(mp, '平尾根弦'), num(t.rootChordH, 0.18) * 1000),
      hStabTipChord: num(pick(mp, '平尾尖弦'), num(t.tipChordH, 0.14) * 1000),
      elevatorChord: num(pick(mp, '升降舵弦长'), 0),
      hStabIncidence: 0,
      // ---- 垂尾 ----
      vStabHeight: num(pick(mp, '垂尾高度（翼展）'), num(t.spanV, 0.2) * 1000),
      vStabRootChord: num(pick(mp, '垂尾根弦'), num(t.rootChordV, 0.16) * 1000),
      vStabTipChord: num(pick(mp, '垂尾尖弦'), num(t.tipChordV, 0.12) * 1000),
      rudderChord: num(pick(mp, '方向舵弦长'), 0),
      vStabSweep: 5,
      // ---- 重心与内部 ----
      cgFromNose: num(pick(mp, '重心距机头'), 0),
      cgPctMac: num(pick(mp, '设计重心'), 30),
      batteryBay: pickText(mp, '电池仓尺寸（长×宽×高）') || '',
      propClearance: num(pick(mp, '桨盘所需净空'), 0),
      // ---- 结构参考 ----
      sparDia: num(pick(mp, '碳管主梁直径'), 6),
      sparPosPct: 30,
      ribSpacing: num(pick(mp, '翼肋间距'), 100),
      // ---- 翼型关键数据 ----
      airfoilName: (af.designation || pickText(mp, '引用翼型') || 'NACA 2412'),
      isRotary: isRotary
    };

    // 翼型坐标（归一化，0..1 弦长），供 VBA / PowerShell 绘制草图
    p.airfoilPoints = (m.airfoilContour && m.airfoilContour.points)
      ? m.airfoilContour.points.map(function (pt) { return [+pt[0], +pt[1]]; })
      : null;

    return p;
  }

  /* =====================================================================
   * 2. VBA 宏生成（Inventor 内置 VBA，零安装）
   * =================================================================== */

  /** 把任意字符串转成 ASCII 安全形式（VBA 按 ANSI 读文件，非 ASCII 会乱码） */
  function asciiOnly(str, dash) {
    var d = dash == null ? '-' : dash;
    var out = String(str == null ? '' : str)
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

  /** 生成 VBA 常量块（纯英文注释，避免 ANSI 乱码） */
  function constBlock(p) {
    const L = [];
    L.push("' ============================================================");
    L.push("'  Project : " + asciiOnly(p.project));
    L.push("'  Type    : " + asciiOnly(p.typeName));
    L.push("'  Generated: " + p.generatedAt);
    L.push("'  Checksum: " + asciiOnly(p.checksum || 'none'));
    L.push("'  Units   : mm for lengths, degrees for angles");
    L.push("' ============================================================");
    L.push("' ---- Baseline ----");
    L.push("Public Const FUS_LEN As Double = " + fmtNum(p.fuselageLength));
    L.push("Public Const FULL_SPAN As Double = " + fmtNum(p.fullSpan));
    L.push("Public Const FULL_HEIGHT As Double = " + fmtNum(p.fullHeight));
    L.push("' ---- Wing ----");
    L.push("Public Const SEMI_SPAN As Double = " + fmtNum(p.semiSpan));
    L.push("Public Const ROOT_CHORD As Double = " + fmtNum(p.rootChord));
    L.push("Public Const TIP_CHORD As Double = " + fmtNum(p.tipChord));
    L.push("Public Const MEAN_CHORD As Double = " + fmtNum(p.meanChord));
    L.push("Public Const MAC_LEN As Double = " + fmtNum(p.mac));
    L.push("Public Const DIHEDRAL_DEG As Double = " + fmtNum(p.dihedral));
    L.push("Public Const SWEEP_DEG As Double = " + fmtNum(p.sweep));
    L.push("Public Const TWIST_DEG As Double = " + fmtNum(p.twist));
    L.push("Public Const MAX_THICK As Double = " + fmtNum(p.maxThickness));
    L.push("Public Const AILERON_CHORD As Double = " + fmtNum(p.aileronChord));
    L.push("Public Const AILERON_START As Double = " + fmtNum(p.aileronStart));
    L.push("Public Const AILERON_END As Double = " + fmtNum(p.aileronEnd));
    L.push("' ---- Fuselage ----");
    L.push("Public Const NOSE_LEN As Double = " + fmtNum(p.noseLength));
    L.push("Public Const WING_MOUNT_LEN As Double = " + fmtNum(p.wingMountLength));
    L.push("Public Const TAIL_ARM As Double = " + fmtNum(p.tailArm));
    L.push("Public Const BODY_W As Double = " + fmtNum(p.bodyMaxWidth));
    L.push("Public Const BODY_H As Double = " + fmtNum(p.bodyMaxHeight));
    L.push("' ---- Horizontal tail ----");
    L.push("Public Const HSTAB_SPAN As Double = " + fmtNum(p.hStabSpan));
    L.push("Public Const HSTAB_ROOT As Double = " + fmtNum(p.hStabRootChord));
    L.push("Public Const HSTAB_TIP As Double = " + fmtNum(p.hStabTipChord));
    L.push("Public Const ELEVATOR_CHORD As Double = " + fmtNum(p.elevatorChord));
    L.push("' ---- Vertical tail ----");
    L.push("Public Const VSTAB_HEIGHT As Double = " + fmtNum(p.vStabHeight));
    L.push("Public Const VSTAB_ROOT As Double = " + fmtNum(p.vStabRootChord));
    L.push("Public Const VSTAB_TIP As Double = " + fmtNum(p.vStabTipChord));
    L.push("Public Const RUDDER_CHORD As Double = " + fmtNum(p.rudderChord));
    L.push("Public Const VSTAB_SWEEP As Double = " + fmtNum(p.vStabSweep));
    L.push("' ---- CG and internals ----");
    L.push("Public Const CG_FROM_NOSE As Double = " + fmtNum(p.cgFromNose));
    L.push("Public Const CG_PCT_MAC As Double = " + fmtNum(p.cgPctMac));
    L.push("Public Const SPAR_DIA As Double = " + fmtNum(p.sparDia));
    L.push("Public Const SPAR_POS_PCT As Double = " + fmtNum(p.sparPosPct));
    L.push("Public Const RIB_SPACING As Double = " + fmtNum(p.ribSpacing));
    L.push("Public Const AIRFOIL_NAME As String = \"" + String(asciiOnly(p.airfoilName)).replace(/"/g, '""') + "\"");
    return L.join('\r\n');
  }

  /** 生成翼型点数组（VBA 字面量） */
  function airfoilArrayBlock(p) {
    const pts = (p.airfoilPoints && p.airfoilPoints.length >= 8) ? p.airfoilPoints : defaultAirfoil();
    const xs = [], ys = [];
    pts.forEach(function (pt) {
      xs.push(fmtNum(pt[0]));
      ys.push(fmtNum(pt[1]));
    });
    const L = [];
    L.push("' ---- Airfoil coordinates (normalised: x 0=LE..1=TE, y = thickness) ----");
    L.push("Private Function AFX(i As Long) As Double");
    L.push("  Dim a As Variant");
    L.push("  a = Array(" + wrapLong(xs, 90, '    ') + ")");
    L.push("  AFX = a(i)");
    L.push("End Function");
    L.push("Private Function AFY(i As Long) As Double");
    L.push("  Dim a As Variant");
    L.push("  a = Array(" + wrapLong(ys, 90, '    ') + ")");
    L.push("  AFY = a(i)");
    L.push("End Function");
    L.push("Private Function AFCount() As Long");
    L.push("  AFCount = " + pts.length);
    L.push("End Function");
    return L.join('\r\n');
  }

  function defaultAirfoil() {
    const out = [];
    const N = 24;
    const yt = function (x) {
      return 0.6 * (0.2969 * Math.sqrt(Math.max(0, x)) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
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

  /** 长数组按行折行，避免 VBA 单行超长 */
  function wrapLong(items, perLine, indent) {
    const lines = [];
    let cur = '';
    items.forEach(function (v, i) {
      cur += (i ? ', ' : '') + v;
      if (cur.length > perLine) { lines.push(cur + ', _'); cur = ''; }
    });
    if (cur) lines.push(cur);
    return '\r\n' + lines.map(function (l) { return indent + l; }).join('\r\n');
  }

  /** 生成完整的 InventorBuild.bas
   *  注意：VBA 编辑器按系统 ANSI 代码页读取 .bas 文件，
   *  文件里出现非 ASCII 字符（中文注释/名称）会乱码，严重时导入失败。
   *  所以这里生成的宏**全是英文 ASCII**，中文说明放在单独的 readme 里。 */
  function buildVba(p) {
    const proj = asciiOnly(p.project);
    const sum = asciiOnly(p.checksum || 'none');
    const body = [
      'Attribute VB_Name = "InventorBuild"',
      "' ============================================================",
      "'  Inventor auto-build macro (generated by RC Aircraft Designer)",
      "'",
      "'  How to use:",
      "'    1. Open Autodesk Inventor (2018 or later)",
      "'    2. Press Alt+F11 to open the VBA editor",
      "'    3. Menu File > Import File... > choose this .bas file",
      "'    4. Press F5 (or Run > Run Sub/UserForm) and pick BuildModel",
      "'",
      "'  Parts created:",
      "'    Wing      airfoil loft, with dihedral / sweep / taper",
      "'    Fuselage  tapered loft (nose > wing bay > tail > tail end)",
      "'    HStab     horizontal tail airfoil loft",
      "'    VStab     vertical tail airfoil loft, with sweep",
      "'",
      "'  All dimensions come from the designer modelling parameter table (mm).",
      "'  Only outer shape and key datums are created. No fillets, ribs,",
      "'  hinge cuts or assembly constraints. See the exported readme.",
      "'",
      "'  Project : " + proj,
      "'  Airfoil : " + asciiOnly(p.airfoilName),
      "'  Checksum: " + sum,
      "'  Units   : mm / degrees",
      "' ============================================================",
      'Option Explicit',
      '',
      constBlock(p),
      '',
      'Private Const PI As Double = 3.14159265358979',
      '',
      airfoilArrayBlock(p),
      '',
      "' ============================================================",
      "'  Entry point",
      "' ============================================================",
      'Public Sub BuildModel()',
      '  Dim oApp As Inventor.Application',
      '  Dim oWing As Inventor.PartDocument',
      '  Dim oFuse As Inventor.PartDocument',
      '  Dim oHStab As Inventor.PartDocument',
      '  Dim oVStab As Inventor.PartDocument',
      '  Dim sLog As String',
      '  On Error GoTo Fail',
      '',
      '  Set oApp = GetInventor()',
      '  oApp.Visible = True',
      '  oApp.SilentOperation = False',
      '  sLog = "Project: ' + proj + '" & vbCrLf & _',
      '         "Airfoil: " & AIRFOIL_NAME & vbCrLf & _',
      '         "Span: " & Format(FULL_SPAN, "0.0") & " mm" & vbCrLf & _',
      '         "Fuselage length: " & Format(FUS_LEN, "0.0") & " mm" & vbCrLf & vbCrLf',
      '',
      '  Set oWing = BuildWing(oApp)',
      '  sLog = sLog & "[OK] Wing (loft)" & vbCrLf',
      '',
      '  Set oFuse = BuildFuselage(oApp)',
      '  sLog = sLog & "[OK] Fuselage (tapered loft)" & vbCrLf',
      '',
      '  Set oHStab = BuildHStab(oApp)',
      '  sLog = sLog & "[OK] Horizontal tail" & vbCrLf',
      '',
      '  Set oVStab = BuildVStab(oApp)',
      '  sLog = sLog & "[OK] Vertical tail" & vbCrLf',
      '',
      '  sLog = sLog & vbCrLf & "All parts created." & vbCrLf & _',
      '         "Next: create an assembly, insert the 4 parts, and locate" & vbCrLf & _',
      '         "them using the coordinates in the modelling parameter table."',
      '  MsgBox sLog, vbInformation, "RC Designer - Inventor build finished"',
      '  Exit Sub',
      '',
      'Fail:',
      '  MsgBox "Build failed: " & Err.Description & vbCrLf & _',
      '         "Make sure Inventor is running and the macro security level" & vbCrLf & _',
      '         "allows macros to run (Tools > Options > General).", _',
      '         vbCritical, "RC Designer"',
      'End Sub',
      '',
      "' ============================================================",
      "'  Helpers",
      "' ============================================================",
      'Private Function GetInventor() As Inventor.Application',
      '  Dim oApp As Inventor.Application',
      '  On Error Resume Next',
      '  Set oApp = GetObject(, "Inventor.Application")',
      '  If oApp Is Nothing Then Set oApp = CreateObject("Inventor.Application")',
      '  On Error GoTo 0',
      '  If oApp Is Nothing Then Err.Raise vbObjectError + 1, , "Cannot start Inventor"',
      '  Set GetInventor = oApp',
      'End Function',
      '',
      'Private Function NewPart(oApp As Inventor.Application) As Inventor.PartDocument',
      '  Dim oDoc As Inventor.PartDocument',
      '  Set oDoc = oApp.Documents.Add(kPartDocumentObject, _',
      '                                oApp.FileManager.GetTemplateFile(kPartDocumentObject), True)',
      '  Set NewPart = oDoc',
      'End Function',
      '',
      'Private Sub SetUnitMM(oDoc As Inventor.PartDocument)',
      '  On Error Resume Next',
      '  oDoc.UnitsOfMeasure.LengthUnits = kMillimeterLengthUnits',
      '  On Error GoTo 0',
      'End Sub',
      '',
      "' Draw one closed airfoil profile on the given work plane",
      'Private Function SketchAirfoil(oDoc As Inventor.PartDocument, _',
      '                               oPlane As Inventor.WorkPlane, _',
      '                               chord As Double, _',
      '                               yOffset As Double, _',
      '                               xOffset As Double, _',
      '                               zOffset As Double, _',
      '                               thicknessScale As Double) As Inventor.PlanarSketch',
      '  Dim oSketch As Inventor.PlanarSketch',
      '  Dim oTg As Inventor.TransientGeometry',
      '  Dim i As Long, n As Long',
      '  Dim px1 As Double, py1 As Double, px2 As Double, py2 As Double',
      '  Set oTg = oDoc.Parent.TransientGeometry',
      '  Set oSketch = oDoc.ComponentDefinition.Sketches.Add(oPlane)',
      '  n = AFCount()',
      '  For i = 0 To n - 2',
      '    px1 = xOffset + AFX(i) * chord',
      '    py1 = yOffset + AFY(i) * chord * thicknessScale',
      '    px2 = xOffset + AFX(i + 1) * chord',
      '    py2 = yOffset + AFY(i + 1) * chord * thicknessScale',
      '    Call oSketch.SketchLines.AddByTwoPoints( _',
      '      oTg.CreatePoint2d(px1, py1), oTg.CreatePoint2d(px2, py2))',
      '  Next i',
      "  ' close the loop",
      '  Call oSketch.SketchLines.AddByTwoPoints( _',
      '    oTg.CreatePoint2d(xOffset + AFX(n - 1) * chord, yOffset + AFY(n - 1) * chord * thicknessScale), _',
      '    oTg.CreatePoint2d(xOffset + AFX(0) * chord, yOffset + AFY(0) * chord * thicknessScale))',
      '  Set SketchAirfoil = oSketch',
      'End Function',
      '',
      "' Wing: root section + tip section -> loft",
      'Private Function BuildWing(oApp As Inventor.Application) As Inventor.PartDocument',
      '  Dim oDoc As Inventor.PartDocument',
      '  Dim oCD As Inventor.PartComponentDefinition',
      '  Dim oRootPlane As Inventor.WorkPlane',
      '  Dim oTipPlane As Inventor.WorkPlane',
      '  Dim oSkRoot As Inventor.PlanarSketch',
      '  Dim oSkTip As Inventor.PlanarSketch',
      '  Dim oProfiles As Inventor.Profile',
      '  Dim dy As Double, dz As Double, dtipZ As Double',
      '',
      '  Set oDoc = NewPart(oApp)',
      '  Set oCD = oDoc.ComponentDefinition',
      '  Call SetUnitMM(oDoc)',
      '  oDoc.DisplayName = "Wing"',
      '',
      "  ' root section on the YZ plane (symmetry plane)",
      '  Set oRootPlane = oCD.WorkPlanes.Item(2)',
      '  oRootPlane.Visible = False',
      '  Set oSkRoot = SketchAirfoil(oDoc, oRootPlane, ROOT_CHORD, 0, 0, 0, 1)',
      '',
      "  ' tip section on a work plane offset by SEMI_SPAN",
      '  dy = SEMI_SPAN',
      '  dz = SEMI_SPAN * Tan(DIHEDRAL_DEG * PI / 180)',
      '  Set oTipPlane = oCD.WorkPlanes.AddByPlaneAndOffset(oRootPlane, dy)',
      '  oTipPlane.Visible = False',
      "  ' apply sweep as a chordwise shift",
      '  dtipZ = SEMI_SPAN * Tan(SWEEP_DEG * PI / 180)',
      '  Set oSkTip = SketchAirfoil(oDoc, oTipPlane, TIP_CHORD, dz, dtipZ, 0, 1)',
      '',
      "  ' loft",
      '  Set oProfiles = oCD.Features.CreateProfile(oCD.Sketches.CreateProfile, kPartFeatureOperationJoin)',
      '  Call oProfiles.Add(oSkRoot.Profiles.Item(1))',
      '  Call oProfiles.Add(oSkTip.Profiles.Item(1))',
      '  Call oCD.Features.LoftFeatures.Add(kJoinOperation, oProfiles)',
      '  Set BuildWing = oDoc',
      'End Function',
      '',
      "' Fuselage: 4 rectangular sections -> loft",
      'Private Function BuildFuselage(oApp As Inventor.Application) As Inventor.PartDocument',
      '  Dim oDoc As Inventor.PartDocument',
      '  Dim oCD As Inventor.PartComponentDefinition',
      '  Dim oXZ As Inventor.WorkPlane',
      '  Dim oSk1 As Inventor.PlanarSketch, oSk2 As Inventor.PlanarSketch',
      '  Dim oSk3 As Inventor.PlanarSketch, oSk4 As Inventor.PlanarSketch',
      '  Dim oProfiles As Inventor.Profile',
      '  Set oDoc = NewPart(oApp)',
      '  Set oCD = oDoc.ComponentDefinition',
      '  Call SetUnitMM(oDoc)',
      '  oDoc.DisplayName = "Fuselage"',
      '  Set oXZ = oCD.WorkPlanes.Item(3)',
      '  oXZ.Visible = False',
      "  ' four sections: nose / wing bay / tail start / tail end",
      '  Set oSk1 = RectSketch(oDoc, oXZ, BODY_W * 0.3, BODY_H * 0.3)',
      '  Set oSk2 = RectSketch(oDoc, oCD.WorkPlanes.AddByPlaneAndOffset(oXZ, NOSE_LEN), BODY_W, BODY_H)',
      '  Set oSk3 = RectSketch(oDoc, oCD.WorkPlanes.AddByPlaneAndOffset(oXZ, NOSE_LEN + WING_MOUNT_LEN), BODY_W, BODY_H)',
      '  Set oSk4 = RectSketch(oDoc, oCD.WorkPlanes.AddByPlaneAndOffset(oXZ, FUS_LEN), BODY_W * 0.28, BODY_H * 0.34)',
      '  Set oProfiles = oCD.Features.CreateProfile(oCD.Sketches.CreateProfile, kPartFeatureOperationJoin)',
      '  Call oProfiles.Add(oSk1.Profiles.Item(1))',
      '  Call oProfiles.Add(oSk2.Profiles.Item(1))',
      '  Call oProfiles.Add(oSk3.Profiles.Item(1))',
      '  Call oProfiles.Add(oSk4.Profiles.Item(1))',
      '  Call oCD.Features.LoftFeatures.Add(kJoinOperation, oProfiles)',
      '  Set BuildFuselage = oDoc',
      'End Function',
      '',
      'Private Function RectSketch(oDoc As Inventor.PartDocument, oPlane As Inventor.WorkPlane, _',
      '                            w As Double, h As Double) As Inventor.PlanarSketch',
      '  Dim oSketch As Inventor.PlanarSketch',
      '  Dim oTg As Inventor.TransientGeometry',
      '  Dim a As Double, b As Double',
      '  Set oTg = oDoc.Parent.TransientGeometry',
      '  Set oSketch = oDoc.ComponentDefinitions.Sketches.Add(oPlane)',
      '  a = w / 2 : b = h / 2',
      '  Call oSketch.SketchLines.AddAsTwoPointRectangle( _',
      '    oTg.CreatePoint2d(-a, -b), oTg.CreatePoint2d(a, b))',
      '  Set RectSketch = oSketch',
      'End Function',
      '',
      "' Horizontal tail",
      'Private Function BuildHStab(oApp As Inventor.Application) As Inventor.PartDocument',
      '  Dim oDoc As Inventor.PartDocument, oCD As Inventor.PartComponentDefinition',
      '  Dim oP As Inventor.WorkPlane, oP2 As Inventor.WorkPlane',
      '  Dim s1 As Inventor.PlanarSketch, s2 As Inventor.PlanarSketch',
      '  Dim oProfiles As Inventor.Profile',
      '  Set oDoc = NewPart(oApp)',
      '  Set oCD = oDoc.ComponentDefinition',
      '  Call SetUnitMM(oDoc)',
      '  oDoc.DisplayName = "HStab"',
      '  Set oP = oCD.WorkPlanes.Item(2)',
      '  oP.Visible = False',
      '  Set s1 = SketchAirfoil(oDoc, oP, HSTAB_ROOT, 0, 0, 0, 1)',
      '  Set oP2 = oCD.WorkPlanes.AddByPlaneAndOffset(oP, HSTAB_SPAN / 2)',
      '  oP2.Visible = False',
      '  Set s2 = SketchAirfoil(oDoc, oP2, HSTAB_TIP, 0, 0, 0, 1)',
      '  Set oProfiles = oCD.Features.CreateProfile(oCD.Sketches.CreateProfile, kPartFeatureOperationJoin)',
      '  Call oProfiles.Add(s1.Profiles.Item(1))',
      '  Call oProfiles.Add(s2.Profiles.Item(1))',
      '  Call oCD.Features.LoftFeatures.Add(kJoinOperation, oProfiles)',
      '  Set BuildHStab = oDoc',
      'End Function',
      '',
      "' Vertical tail",
      'Private Function BuildVStab(oApp As Inventor.Application) As Inventor.PartDocument',
      '  Dim oDoc As Inventor.PartDocument, oCD As Inventor.PartComponentDefinition',
      '  Dim oP As Inventor.WorkPlane, oP2 As Inventor.WorkPlane',
      '  Dim s1 As Inventor.PlanarSketch, s2 As Inventor.PlanarSketch',
      '  Dim oProfiles As Inventor.Profile',
      '  Dim dz As Double',
      '  Set oDoc = NewPart(oApp)',
      '  Set oCD = oDoc.ComponentDefinition',
      '  Call SetUnitMM(oDoc)',
      '  oDoc.DisplayName = "VStab"',
      '  Set oP = oCD.WorkPlanes.Item(2)',
      '  oP.Visible = False',
      '  Set s1 = SketchAirfoil(oDoc, oP, VSTAB_ROOT, 0, 0, 0, 1)',
      '  Set oP2 = oCD.WorkPlanes.AddByPlaneAndOffset(oP, VSTAB_HEIGHT)',
      '  oP2.Visible = False',
      '  dz = VSTAB_HEIGHT * Tan(VSTAB_SWEEP * PI / 180)',
      '  Set s2 = SketchAirfoil(oDoc, oP2, VSTAB_TIP, 0, dz, 0, 1)',
      '  Set oProfiles = oCD.Features.CreateProfile(oCD.Sketches.CreateProfile, kPartFeatureOperationJoin)',
      '  Call oProfiles.Add(s1.Profiles.Item(1))',
      '  Call oProfiles.Add(s2.Profiles.Item(1))',
      '  Call oCD.Features.LoftFeatures.Add(kJoinOperation, oProfiles)',
      '  Set BuildVStab = oDoc',
      'End Function'
    ];
    return body.join('\r\n');
  }

  /* =====================================================================
   * 3. 使用说明
   * =================================================================== */
  function readme(p) {
    const L = [];
    L.push('RC 飞行器总体设计器 —— Inventor 自动建模包');
    L.push('='.repeat(60));
    L.push('');
    L.push('方案：' + p.project + '（' + p.typeName + '）');
    L.push('翼型：' + p.airfoilName);
    L.push('生成时间：' + p.generatedAt);
    L.push('校验码：' + (p.checksum || '—'));
    L.push('');
    L.push('本包内文件：');
    L.push('  InventorBuild.bas      Inventor VBA 宏（导入后运行即可建模）');
    L.push('  inventor_params.json   全部尺寸参数（mm），留档与二次开发用');
    L.push('');
    L.push('─'.repeat(60));
    L.push('【路径 A：零安装，手动导入宏（推荐先用这个）】');
    L.push('─'.repeat(60));
    L.push('1. 打开 Autodesk Inventor（2018 及以上）');
    L.push('2. 按 Alt + F11 打开 VBA 编辑器');
    L.push('3. 菜单：文件 → 导入文件…  → 选择 InventorBuild.bas');
    L.push('4. 按 F5，选择 BuildModel 运行');
    L.push('5. 等几秒，会弹出「建模完成」，同时生成 4 个零件：');
    L.push('     Wing / Fuselage / HStab / VStab');
    L.push('');
    L.push('如果提示「宏已被禁用」：');
    L.push('  工具 → 选项 → 常规 → 宏安全级别 → 调成「中」或「低」，重启 Inventor');
    L.push('');
    L.push('─'.repeat(60));
    L.push('【路径 B：一键建模（网页直接点按钮）】');
    L.push('─'.repeat(60));
    L.push('1. 在电脑上双击 inventor-bridge 文件夹里的「启动Inventor桥.bat」');
    L.push('2. 它会打印一行「Inventor 桥已启动」');
    L.push('3. 回到网页，切到「Inventor 建模」标签，点「直接让 Inventor 建模」');
    L.push('4. Inventor 会自动打开并生成零件');
    L.push('');
    L.push('桥只在你的电脑本机运行（127.0.0.1），不上传任何数据。');
    L.push('关掉那个黑窗口，桥就停止。');
    L.push('');
    L.push('─'.repeat(60));
    L.push('【主要尺寸一览】（mm）');
    L.push('─'.repeat(60));
    const rows = [
      ['总翼展', p.fullSpan], ['半翼展', p.semiSpan],
      ['根弦', p.rootChord], ['尖弦', p.tipChord], ['平均弦长', p.meanChord],
      ['上反角(°)', p.dihedral], ['后掠角(°)', p.sweep],
      ['机身总长', p.fuselageLength], ['机身最大宽', p.bodyMaxWidth], ['机身最大高', p.bodyMaxHeight],
      ['平尾翼展', p.hStabSpan], ['平尾根弦', p.hStabRootChord], ['平尾尖弦', p.hStabTipChord],
      ['垂尾高度', p.vStabHeight], ['垂尾根弦', p.vStabRootChord], ['垂尾尖弦', p.vStabTipChord],
      ['重心距机头', p.cgFromNose], ['碳管主梁直径', p.sparDia], ['翼肋间距', p.ribSpacing]
    ];
    rows.forEach(function (r) {
      L.push('  ' + String(r[0]).padEnd(14, '　') + '  ' + (typeof r[1] === 'number' ? r[1].toFixed(1) : '—'));
    });
    L.push('');
    L.push('─'.repeat(60));
    L.push('【宏生成的内容】');
    L.push('─'.repeat(60));
    L.push('· 机翼：翼型轮廓按根弦/尖弦放样，含上反角、后掠角、梢根比');
    L.push('· 机身：机头→机翼段→尾段→尾端 四截面锥形放样');
    L.push('· 平尾：翼型按根弦/尖弦放样');
    L.push('· 垂尾：翼型按根弦/尖弦放样，含后掠角');
    L.push('');
    L.push('未包含（需要手工补）：倒角与圆角、翼肋与主梁、舵面切割、');
    L.push('装配约束、起落架、电机座。这些依赖细节设计，宏不替你决定。');
    L.push('');
    return L.join('\r\n');
  }

  function paramsToJson(p) {
    return JSON.stringify(p, null, 2);
  }

  return {
    FORMAT: FORMAT,
    paramsFromCore: paramsFromCore,
    asciiOnly: asciiOnly,
    buildVba: buildVba,
    readme: readme,
    paramsToJson: paramsToJson,
    defaultAirfoil: defaultAirfoil,
    airfoilArrayBlock: airfoilArrayBlock,
    constBlock: constBlock
  };
});
