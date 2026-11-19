#if VER != EncodeVer(6, 7, 3)
  #error MshTV requires Inno Setup 6.7.3
#endif
#ifndef ProductKey
  #define ProductKey "MshTV"
#endif
#ifndef ProductVersion
  #define ProductVersion "0.9.4"
#endif

[Setup]
AppId={#ProductKey}.WindowsLauncher
AppName={#ProductKey}
AppVersion={#ProductVersion}
AppPublisher=MshTV
DefaultDirName={localappdata}\Programs\{#ProductKey}
DefaultGroupName={#ProductKey}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19044
WizardStyle=modern dark slate includetitlebar
DisableStartupPrompt=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
UsePreviousAppDir=yes
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\MshTV.exe
SetupIconFile=..\src\MshTV.Launcher\Assets\MshTV.ico
OutputBaseFilename={#ProductKey}-Setup-{#ProductVersion}-win-x64
Compression=lzma2/fast
SolidCompression=yes

[Languages]
Name: "zh"; MessagesFile: "compiler:Default.isl,WindowsMessages.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#ProductKey}"; Filename: "{app}\MshTV.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\{#ProductKey}"; Filename: "{app}\MshTV.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\MshTV.exe"; Description: "打开 MshTV 启动管理中心"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{app}\install-data.txt"

[Code]
const
  PreferenceKey = 'Software\MshTV\{#ProductKey}';
var
  DataPage: TInputDirWizardPage;
  Previous, ExistingData: String;

function Normalize(Path: String): String;
begin
  Result := RemoveBackslashUnlessRoot(ExpandFileName(Trim(Path)));
end;

function IncludesPath(Parent, Child: String): Boolean;
begin
  Parent := Lowercase(Normalize(Parent));
  Child := Lowercase(Normalize(Child));
  Result := (Parent = Child) or (Pos(AddBackslash(Parent), Child) = 1);
end;

function HasEntries(Path: String): Boolean;
var Item: TFindRec;
begin
  Result := False;
  if not FindFirst(AddBackslash(Path) + '*', Item) then Exit;
  try
    repeat
      if (Item.Name <> '.') and (Item.Name <> '..') then begin
        Result := True;
        Exit;
      end;
    until not FindNext(Item);
  finally
    FindClose(Item);
  end;
end;

function IsLocalFolder(Path: String): Boolean;
begin
  Result := (Length(Path) > 3) and (Copy(Path, 2, 2) = ':\') and (Pos(':', Copy(Path, 3, Length(Path))) = 0);
end;

function HasProjects(Path: String): Boolean;
begin
  Result := IsLocalFolder(Path) and (FileExists(AddBackslash(Path) + 'canvas.db') or FileExists(AddBackslash(Path) + 'storage-location.json'));
end;

function FileAttributes(Path: String): LongWord;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function CanWriteFolder(Path: String): Boolean;
var Parent, Probe: String; Attr: LongWord;
begin
  Result := False;
  Parent := Path;
  while not DirExists(Parent) do begin
    if (Length(Parent) <= 3) or FileExists(Parent) then Exit;
    Parent := RemoveBackslashUnlessRoot(ExtractFileDir(Parent));
    if Length(Parent) < 3 then Exit;
  end;
  Path := Parent;
  while Length(Path) > 3 do begin
    Attr := FileAttributes(Path);
    if (Attr = $FFFFFFFF) or ((Attr and $400) <> 0) then Exit;
    Path := RemoveBackslashUnlessRoot(ExtractFileDir(Path));
  end;
  Probe := AddBackslash(Parent) + '.mshtv-setup-' + IntToStr(Random(1000000000)) + '.tmp';
  if FileExists(Probe) or not SaveStringToFile(Probe, '', False) then Exit;
  Result := DeleteFile(Probe);
end;

procedure InitializeWizard;
var Suggested, EnvData: String;
begin
  Previous := GetPreviousData('ApplicationFolder', '');
  Suggested := GetPreviousData('ProjectDataFolder', '');
  #if ProductKey == "MshTV"
    if Suggested = '' then RegQueryStringValue(HKCU, PreferenceKey, 'LastDataFolder', Suggested);
  #endif
  if Suggested = '' then begin
    EnvData := GetEnv('MSHTV_DATA_DIR');
    if HasProjects(EnvData) then Suggested := EnvData
    else Suggested := ExpandConstant('{localappdata}\{#ProductKey}\data');
  end;
  if HasProjects(Suggested) then ExistingData := Normalize(Suggested);
  DataPage := CreateInputDirPage(wpSelectDir, '项目数据目录', '指定工作空间与画布的存储位置',
    '请选择独立于程序的本机文件夹。缓存默认在数据目录中的 media-cache。' + #13#10 +
    '已有 MshTV 项目可直接接续原数据文件夹，也可在安装后通过「备份与迁移」换盘。', False, '');
  DataPage.Add('项目数据目录');
  DataPage.Values[0] := ExpandConstant('{param:DATADIR|}');
  if DataPage.Values[0] = '' then DataPage.Values[0] := Suggested;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (Previous <> '') and ((PageID = wpSelectDir) or (PageID = DataPage.ID));
end;

function Preflight: String;
var AppFolder, DataFolder: String;
begin
  AppFolder := Normalize(WizardDirValue);
  DataFolder := Normalize(DataPage.Values[0]);
  Result := '';
  if not IsLocalFolder(AppFolder) or not IsLocalFolder(DataFolder) then
    Result := '请为程序和项目数据选择两个非磁盘根目录的本机文件夹。'
  else if IncludesPath(AppFolder, DataFolder) or IncludesPath(DataFolder, AppFolder) then
    Result := '程序目录和项目数据目录必须分开，且不能相互嵌套。'
  else if (Previous <> '') and (CompareText(Normalize(Previous), AppFolder) <> 0) then
    Result := '升级时请使用原程序目录。'
  else if (Previous = '') and DirExists(AppFolder) and HasEntries(AppFolder) then
    Result := '请选择空的程序目录，避免覆盖其他文件。'
  else if (ExistingData <> '') and (CompareText(ExistingData, DataFolder) <> 0) then
    Result := '已识别到现有项目。请先接续原数据目录，完成安装后使用「备份与迁移」更换位置。'
  else if DirExists(DataFolder) and HasEntries(DataFolder) and not HasProjects(DataFolder) then
    Result := '数据目录已有其他文件。请选择空文件夹，或已有的 MshTV 数据目录。';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var Error: String;
begin
  Result := True;
  if CurPageID = DataPage.ID then begin
    Error := Preflight;
    Result := Error = '';
    if not Result then MsgBox(Error, mbError, MB_OK);
  end;
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'ApplicationFolder', Normalize(WizardDirValue));
  SetPreviousData(PreviousDataKey, 'ProjectDataFolder', Normalize(DataPage.Values[0]));
end;

function CloseLauncher(Path: String): Boolean;
var Code: Integer;
begin
  Result := not FileExists(Path);
  if not Result then
    Result := Exec(Path, '--close-for-setup', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Current, Target: Int64;
begin
  Result := Preflight;
  if Result <> '' then Exit;
  if not CanWriteFolder(Normalize(WizardDirValue)) or not CanWriteFolder(Normalize(DataPage.Values[0])) then begin
    Result := '安装或数据目录不可写，或使用了链接。请选择两个可写的本机文件夹。';
    Exit;
  end;
  if Previous <> '' then begin
    if GetPackedVersion(AddBackslash(Previous) + 'MshTV.exe', Current) and StrToVersion('{#ProductVersion}.0', Target) and
      (ComparePackedVersion(Current, Target) > 0) then
        Result := '已经安装更新的 MshTV 版本，请使用同版或更新的安装包。'
    else if not CloseLauncher(AddBackslash(Previous) + 'MshTV.exe') then
      Result := '无法安全停止现有 MshTV。请保存画布，完全退出启动器，然后重试。';
  end;
end;

procedure CurStepChanged(Step: TSetupStep);
var Launcher, Folder: String; Code: Integer;
begin
  if Step <> ssPostInstall then Exit;
  Launcher := ExpandConstant('{app}\MshTV.exe');
  Folder := Normalize(DataPage.Values[0]);
  if not Exec(Launcher, '--configure-data ' + AddQuotes(Folder), '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    RaiseException('无法登记项目数据目录。请检查数据目录权限，并确认未使用符号链接或已迁移的安装目录。');
  if not Exec(Launcher, '--self-check', '', SW_HIDE, ewWaitUntilTerminated, Code) or ((Code <> 0) and (Code <> 5)) then
    RaiseException('安装文件或数据目录未通过校验。请确认目录可读写，重新运行同版安装包。');
  if Code = 5 then
    SuppressibleMsgBox('本机端口 5188 已占用。安装可以完成。打开启动管理中心前，请保存画布并退出当前使用此端口的程序。', mbInformation, MB_OK, IDOK);
  #if ProductKey == "MshTV"
    RegWriteStringValue(HKCU, PreferenceKey, 'LastDataFolder', Folder);
  #endif
end;

procedure CurUninstallStepChanged(Step: TUninstallStep);
begin
  if (Step = usUninstall) and not CloseLauncher(ExpandConstant('{app}\MshTV.exe')) then
    RaiseException('无法安全停止 MshTV。请先保存并完全退出，再卸载。');
end;
