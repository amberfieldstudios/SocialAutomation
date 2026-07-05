// SocialAutomation.exe -- double-click launcher.
//
// What it does:
//   1. Locates a Node.js runtime to run the app with -- prefers the runtime
//      BUNDLED with this distributable (runtime\node-win-x64\node.exe, next
//      to this exe's repo root; see launcher\fetch-node-runtime.ps1), so a
//      user with NO Node.js installed can still run the app. Falls back to
//      a PATH `node` >= 22 only as a developer convenience when running this
//      exe straight out of a source checkout that hasn't been packaged.
//   2. Runs launcher\bootstrap.mjs with that node, hidden (no raw console
//      window). bootstrap.mjs prints small `##STATUS##{json}` progress
//      lines on stdout, which this program parses to drive a plain-language
//      progress window -- no wall of pnpm/npm install output.
//   3. bootstrap.mjs itself picks a free port (in case the default is
//      already taken) and starts the production server; this program learns
//      the actual port from the status lines and opens the user's default
//      browser there once the server reports ready.
//   4. The progress/status window IS the app's on-screen presence while
//      running: closing it terminates the whole node process tree (bootstrap
//      + the actual server process), same "close the window to stop the
//      app" model as before, just without a raw console full of logs.
//
// The exe locates the repo by its own path (parent of the `launcher\`
// directory containing this source, i.e. wherever SocialAutomation.exe
// itself sits), so the folder can be moved/copied intact.
//
// Compiled with the in-box .NET Framework csc.exe -- see build.ps1.

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        string repoRoot = FindRepoRoot();

        if (!File.Exists(Path.Combine(repoRoot, "package.json")))
        {
            MessageBox.Show(
                "Could not find package.json next to SocialAutomation.exe (looked in:\n" + repoRoot +
                "\n\nMake sure the exe stays inside the SocialAutomation folder.",
                "SocialAutomation - App not found",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        string nodeExe;
        string nodeError;
        if (!ResolveNode(repoRoot, out nodeExe, out nodeError))
        {
            MessageBox.Show(
                nodeError,
                "SocialAutomation - could not start",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        string bootstrapScript = Path.Combine(repoRoot, "launcher", "bootstrap.mjs");
        if (!File.Exists(bootstrapScript))
        {
            MessageBox.Show(
                "This copy of SocialAutomation is missing launcher\\bootstrap.mjs and can't start.\n\n" +
                "Please re-download SocialAutomation.",
                "SocialAutomation - App not found",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = "\"" + bootstrapScript + "\"",
            WorkingDirectory = repoRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        Process bootstrapProcess;
        try
        {
            bootstrapProcess = Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Failed to start SocialAutomation:\n" + ex.Message,
                "SocialAutomation - Launch failed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        using (var progress = new ProgressForm(bootstrapProcess))
        {
            bootstrapProcess.OutputDataReceived += (s, e) => progress.HandleLine(e.Data);
            bootstrapProcess.ErrorDataReceived += (s, e) => progress.HandleLine(e.Data);
            bootstrapProcess.BeginOutputReadLine();
            bootstrapProcess.BeginErrorReadLine();

            Application.Run(progress);
        }

        return 0;
    }

    /// <summary>
    /// The exe ships at the repo root (sibling of package.json); this source
    /// lives at &lt;root&gt;/launcher/Program.cs. Resolve from the exe's own
    /// location, not a hardcoded path, so the repo can be moved/copied.
    /// </summary>
    private static string FindRepoRoot()
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string dir = exeDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        for (int i = 0; i < 4 && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir, "package.json")) &&
                File.Exists(Path.Combine(dir, "pnpm-workspace.yaml")))
            {
                return dir;
            }
            dir = Path.GetDirectoryName(dir);
        }
        return exeDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    /// <summary>
    /// Prefers the runtime bundled with this distributable
    /// (runtime\node-win-x64\node.exe). Falls back to a PATH `node` >= 22
    /// only when no bundled runtime is present (a from-source/dev checkout).
    /// </summary>
    private static bool ResolveNode(string repoRoot, out string nodeExe, out string error)
    {
        string bundled = Path.Combine(repoRoot, "runtime", "node-win-x64", "node.exe");
        if (File.Exists(bundled))
        {
            nodeExe = bundled;
            error = null;
            return true;
        }

        // Dev-checkout fallback: no bundled runtime staged (see
        // launcher\fetch-node-runtime.ps1) -- try PATH node >= 22.
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "--version",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using (var proc = Process.Start(psi))
            {
                string stdout = proc.StandardOutput.ReadToEnd().Trim();
                proc.WaitForExit(5000);
                string versionText = stdout.TrimStart('v', 'V');
                int dot = versionText.IndexOf('.');
                int major;
                if (dot > 0 && int.TryParse(versionText.Substring(0, dot), out major) && major >= 22)
                {
                    nodeExe = "node";
                    error = null;
                    return true;
                }
            }
        }
        catch
        {
            // fall through to the error below
        }

        nodeExe = null;
        error =
            "SocialAutomation couldn't find a Node.js runtime to run with.\n\n" +
            "This copy is missing its bundled runtime (runtime\\node-win-x64\\node.exe) -- " +
            "it may not have finished downloading, or a file was deleted. Please re-download " +
            "SocialAutomation from the release page.\n\n" +
            "(If you're a developer running from source without a packaged build, install " +
            "Node.js 22+ from https://nodejs.org/ and make sure it's on PATH, or run " +
            "launcher\\fetch-node-runtime.ps1 to stage a bundled runtime.)";
        return false;
    }

    /// <summary>
    /// Small always-on-top progress window shown while SocialAutomation
    /// starts and runs. Parses `##STATUS##{json}` lines from bootstrap.mjs's
    /// stdout to update its message; opens the browser once the server
    /// reports ready; shows a plain-language MessageBox and closes on error.
    /// Closing this window (directly, or via its own "Quit" button) kills the
    /// whole bootstrap/server process tree -- this window is the on-screen
    /// "SocialAutomation is running" presence while the app is up.
    /// </summary>
    private sealed class ProgressForm : Form
    {
        private readonly Process _process;
        private readonly Label _label;
        private readonly ProgressBar _bar;
        private readonly Button _quitButton;
        private bool _ready;
        private bool _closingIntentionally;
        private string _url;

        public ProgressForm(Process process)
        {
            _process = process;

            Text = "SocialAutomation";
            Width = 460;
            Height = 160;
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            TopMost = false;

            _label = new Label
            {
                Text = "Starting SocialAutomation...",
                Left = 20,
                Top = 20,
                Width = 420,
                Height = 40,
                AutoEllipsis = true,
            };
            _bar = new ProgressBar
            {
                Left = 20,
                Top = 65,
                Width = 420,
                Height = 20,
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 30,
            };
            _quitButton = new Button
            {
                Text = "Quit SocialAutomation",
                Left = 300,
                Top = 95,
                Width = 140,
                Height = 30,
            };
            _quitButton.Click += (s, e) =>
            {
                _closingIntentionally = true;
                Close();
            };

            Controls.Add(_label);
            Controls.Add(_bar);
            Controls.Add(_quitButton);

            FormClosing += OnFormClosing;
            process.Exited += (s, e) => BeginInvoke((Action)OnProcessExited);
            process.EnableRaisingEvents = true;
        }

        /// <summary>Called on the process's own thread via OutputDataReceived/ErrorDataReceived; marshals to the UI thread.</summary>
        public void HandleLine(string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            if (!line.StartsWith("##STATUS##")) return;

            string json = line.Substring("##STATUS##".Length);
            string stage, message, url;
            ParseStatusJson(json, out stage, out message, out url);

            if (IsDisposed) return;
            try
            {
                BeginInvoke((Action)(() => ApplyStatus(stage, message, url)));
            }
            catch (ObjectDisposedException)
            {
                // Window already closing; ignore late updates.
            }
        }

        private void ApplyStatus(string stage, string message, string url)
        {
            if (!string.IsNullOrEmpty(message))
            {
                _label.Text = message;
            }

            if (stage == "ready")
            {
                _ready = true;
                _url = url;
                _bar.Style = ProgressBarStyle.Continuous;
                _bar.Value = 100;
                _label.Text = "SocialAutomation is running. Opening your browser...";
                try
                {
                    if (!string.IsNullOrEmpty(url))
                    {
                        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
                    }
                }
                catch
                {
                    // Best-effort; the window still shows the URL text below.
                }
                _label.Text = "SocialAutomation is running at " + url + "\nClose this window (or click Quit) to stop it.";
            }
            else if (stage == "error")
            {
                MessageBox.Show(
                    message,
                    "SocialAutomation - could not start",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                _closingIntentionally = true;
                Close();
            }
        }

        private void OnProcessExited()
        {
            if (_closingIntentionally || IsDisposed) return;
            if (!_ready)
            {
                MessageBox.Show(
                    "SocialAutomation stopped unexpectedly before it finished starting up.",
                    "SocialAutomation - stopped",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
            _closingIntentionally = true;
            Close();
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            KillProcessTree(_process);
        }

        private static void KillProcessTree(Process process)
        {
            try
            {
                if (process == null || process.HasExited) return;
                // .NET Framework's Process.Kill() only kills the one process;
                // bootstrap.mjs spawns a child (the actual server) via
                // spawn(), so use taskkill's process-tree kill to make sure
                // both go down when the window closes.
                var killer = new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = "/PID " + process.Id + " /T /F",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (var p = Process.Start(killer))
                {
                    p.WaitForExit(5000);
                }
            }
            catch
            {
                try { process.Kill(); } catch { /* best effort */ }
            }
        }

        /// <summary>
        /// Minimal hand-rolled JSON field extraction for the small flat
        /// {"stage":"...","message":"...","url":"..."} objects bootstrap.mjs
        /// emits -- avoids pulling in a JSON library for three string fields.
        /// </summary>
        private static void ParseStatusJson(string json, out string stage, out string message, out string url)
        {
            stage = ExtractField(json, "stage");
            message = ExtractField(json, "message");
            url = ExtractField(json, "url");
        }

        private static string ExtractField(string json, string field)
        {
            string needle = "\"" + field + "\":\"";
            int start = json.IndexOf(needle, StringComparison.Ordinal);
            if (start < 0) return null;
            start += needle.Length;
            var sb = new StringBuilder();
            for (int i = start; i < json.Length; i++)
            {
                char c = json[i];
                if (c == '\\' && i + 1 < json.Length)
                {
                    char next = json[i + 1];
                    if (next == 'n') { sb.Append('\n'); i++; continue; }
                    if (next == '"' || next == '\\') { sb.Append(next); i++; continue; }
                    sb.Append(next);
                    i++;
                    continue;
                }
                if (c == '"') break;
                sb.Append(c);
            }
            return sb.ToString();
        }
    }
}
