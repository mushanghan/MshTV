using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace MshTV.Server.Network;

internal static class LanCertificates
{
    public static (byte[] Authority, byte[] ProtectedKey) Create(IPAddress address)
    {
        using var issuerKey = RSA.Create(3072);
        var issuer = new CertificateRequest($"CN=MshTV LAN {Guid.NewGuid():N}", issuerKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        issuer.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
        issuer.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        issuer.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(issuer.PublicKey, false));
        var now = DateTimeOffset.UtcNow;
        using var authority = issuer.CreateSelfSigned(now.AddMinutes(-5), now.AddYears(2));
        using var serverKey = RSA.Create(2048);
        var server = new CertificateRequest($"CN={address}", serverKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var names = new SubjectAlternativeNameBuilder();
        names.AddIpAddress(address);
        server.CertificateExtensions.Add(names.Build());
        server.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        server.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        server.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
        using var signed = server.Create(authority, now.AddMinutes(-4), now.AddDays(365), RandomNumberGenerator.GetBytes(16));
        using var certificate = signed.CopyWithPrivateKey(serverKey);
        var pfx = certificate.Export(X509ContentType.Pfx);
        try { return (authority.RawData, Protect(pfx, true)); }
        finally { CryptographicOperations.ZeroMemory(pfx); }
    }

    public static X509Certificate2 Load(byte[] encrypted)
    {
        var pfx = Protect(encrypted, false);
        try { return X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.UserKeySet); }
        finally { CryptographicOperations.ZeroMemory(pfx); }
    }

    private static byte[] Protect(byte[] data, bool encrypt)
    {
        var input = new Blob { Size = data.Length, Data = Marshal.AllocHGlobal(data.Length) };
        Blob output = default;
        try
        {
            Marshal.Copy(data, 0, input.Data, data.Length);
            const int noUi = 1;
            var success = encrypt
                ? CryptProtectData(ref input, null, 0, 0, 0, noUi, out output)
                : CryptUnprotectData(ref input, 0, 0, 0, 0, noUi, out output);
            if (!success) throw new CryptographicException(Marshal.GetLastWin32Error());
            var result = new byte[output.Size];
            Marshal.Copy(output.Data, result, 0, result.Length);
            return result;
        }
        finally
        {
            Marshal.Copy(new byte[input.Size], 0, input.Data, input.Size);
            Marshal.FreeHGlobal(input.Data);
            if (output.Data != 0)
            {
                Marshal.Copy(new byte[output.Size], 0, output.Data, output.Size);
                LocalFree(output.Data);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Blob { public int Size; public nint Data; }
    [DllImport("crypt32", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(ref Blob input, string? description, nint entropy, nint reserved, nint prompt, int flags, out Blob output);
    [DllImport("crypt32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(ref Blob input, nint description, nint entropy, nint reserved, nint prompt, int flags, out Blob output);
    [DllImport("kernel32")]
    private static extern nint LocalFree(nint memory);
}
