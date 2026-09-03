using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Medha Data Analyser")]
[assembly: AssemblyDescription("MEC628 locomotive data analyser")]
[assembly: AssemblyCompany("ELS/ED")]
[assembly: AssemblyProduct("Medha Data Analyser")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class MedhaLauncher
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string InstallEngine()
    {
        string runtimeDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MedhaDataAnalyser",
            "1.0"
        );
        Directory.CreateDirectory(runtimeDirectory);
        string enginePath = Path.Combine(runtimeDirectory, "MedhaEngine.exe");
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("MedhaEngine"))
        {
            if (resource == null) throw new InvalidOperationException("The analyser engine is missing");
            if (File.Exists(enginePath) && new FileInfo(enginePath).Length == resource.Length)
                return enginePath;
            string staging = Path.Combine(runtimeDirectory, "MedhaEngine.new");
            using (FileStream output = new FileStream(staging, FileMode.Create, FileAccess.Write, FileShare.None))
                resource.CopyTo(output);
            if (File.Exists(enginePath)) File.Delete(enginePath);
            File.Move(staging, enginePath);
        }
        return enginePath;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool ownsMutex;
        using (var instance = new Mutex(true, "Local\\MedhaDataAnalyser-ELS-ED-1.0", out ownsMutex))
        {
            if (!ownsMutex)
            {
                MessageBox.Show(
                    "Medha Data Analyser is already running in another browser tab.",
                    "Medha Data Analyser 1.0",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                return 0;
            }
            try
            {
                string enginePath = InstallEngine();
                string readyFile = Path.Combine(
                    Path.GetTempPath(),
                    "medha-ready-" + Process.GetCurrentProcess().Id + ".json"
                );
                if (File.Exists(readyFile)) File.Delete(readyFile);
                string[] engineArgs = new[]
                {
                    "--browser", "--quiet", "--parent-pid", Process.GetCurrentProcess().Id.ToString()
                }.Concat(args).Concat(new[] { "--ready-file", readyFile }).ToArray();
                var start = new ProcessStartInfo
                {
                    FileName = enginePath,
                    Arguments = string.Join(" ", engineArgs.Select(Quote)),
                    WorkingDirectory = Path.GetDirectoryName(enginePath),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (Process engine = Process.Start(start))
                {
                    if (engine == null) throw new InvalidOperationException("The analyser engine did not start");
                    bool ready = false;
                    using (var splash = new Form())
                    using (var timer = new System.Windows.Forms.Timer())
                    {
                        splash.Text = "Medha Data Analyser 1.0";
                        splash.ClientSize = new Size(430, 145);
                        splash.StartPosition = FormStartPosition.CenterScreen;
                        splash.FormBorderStyle = FormBorderStyle.FixedDialog;
                        splash.ControlBox = false;
                        splash.ShowInTaskbar = false;
                        splash.TopMost = true;
                        splash.BackColor = Color.White;
                        var title = new Label
                        {
                            Text = "MEDHA DATA ANALYSER",
                            Font = new Font("Segoe UI", 16, FontStyle.Bold),
                            ForeColor = Color.FromArgb(11, 59, 97),
                            AutoSize = false,
                            TextAlign = ContentAlignment.MiddleCenter,
                            Bounds = new Rectangle(18, 14, 394, 36)
                        };
                        var status = new Label
                        {
                            Text = "Starting the local analyser securely...",
                            Font = new Font("Segoe UI", 10),
                            ForeColor = Color.FromArgb(74, 105, 125),
                            AutoSize = false,
                            TextAlign = ContentAlignment.MiddleCenter,
                            Bounds = new Rectangle(18, 52, 394, 27)
                        };
                        var progress = new ProgressBar
                        {
                            Style = ProgressBarStyle.Marquee,
                            MarqueeAnimationSpeed = 24,
                            Bounds = new Rectangle(42, 91, 346, 14)
                        };
                        var credit = new Label
                        {
                            Text = "Developed by ELS/ED | Version 1.0",
                            Font = new Font("Segoe UI", 8),
                            ForeColor = Color.FromArgb(95, 125, 143),
                            AutoSize = false,
                            TextAlign = ContentAlignment.MiddleCenter,
                            Bounds = new Rectangle(18, 112, 394, 20)
                        };
                        splash.Controls.Add(title);
                        splash.Controls.Add(status);
                        splash.Controls.Add(progress);
                        splash.Controls.Add(credit);
                        timer.Interval = 200;
                        timer.Tick += delegate
                        {
                            if (File.Exists(readyFile)) { ready = true; splash.Close(); }
                            else if (engine.HasExited) splash.Close();
                        };
                        splash.Shown += delegate { timer.Start(); };
                        Application.Run(splash);
                    }
                    if (!ready && engine.HasExited)
                        throw new InvalidOperationException("The analyser engine stopped during startup");
                    engine.WaitForExit();
                    try { if (File.Exists(readyFile)) File.Delete(readyFile); } catch { }
                    return engine.ExitCode;
                }
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "Medha Data Analyser could not start.\n\n" + error.Message,
                    "Medha Data Analyser 1.0",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }
            finally
            {
                instance.ReleaseMutex();
            }
        }
    }
}
