import { applyTlsFallback, TlsCluster } from '../tls';

function makeKc(clusters: TlsCluster[]): { clusters: TlsCluster[] } {
  return { clusters };
}

describe('applyTlsFallback', () => {
  const OLD_ENV = process.env.K8S_SKIP_TLS_VERIFY;

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.K8S_SKIP_TLS_VERIFY;
    else process.env.K8S_SKIP_TLS_VERIFY = OLD_ENV;
  });

  it('skips TLS verify when cluster has no CA data (self-signed cert support)', () => {
    const kc = makeKc([{ name: 'c1', server: 'https://10.0.0.1:6443' }]);
    applyTlsFallback(kc);
    expect(kc.clusters[0].skipTLSVerify).toBe(true);
  });

  it('skips TLS verify when CA is a file path that does not exist locally', () => {
    const kc = makeKc([{ name: 'c1', server: 'https://10.0.0.1:6443', caFile: '/nonexistent/ca.crt' }]);
    applyTlsFallback(kc);
    expect(kc.clusters[0].skipTLSVerify).toBe(true);
  });

  it('keeps TLS verify when cluster provides certificate-authority-data', () => {
    const kc = makeKc([{ name: 'c1', server: 'https://10.0.0.1:6443', caData: 'dGVzdC1jYQ==' }]);
    applyTlsFallback(kc);
    expect(kc.clusters[0].skipTLSVerify).toBeFalsy();
  });

  it('keeps TLS verify when CA file path exists', () => {
    const kc = makeKc([{ name: 'c1', server: 'https://10.0.0.1:6443', caFile: __filename }]);
    applyTlsFallback(kc);
    expect(kc.clusters[0].skipTLSVerify).toBeFalsy();
  });

  it('force-skips TLS verify for all clusters when K8S_SKIP_TLS_VERIFY=true', () => {
    process.env.K8S_SKIP_TLS_VERIFY = 'true';
    const kc = makeKc([{ name: 'c1', server: 'https://10.0.0.1:6443', caData: 'dGVzdC1jYQ==' }]);
    applyTlsFallback(kc);
    expect(kc.clusters[0].skipTLSVerify).toBe(true);
  });

  it('preserves skipTLSVerify already set from kubeconfig insecure-skip-tls-verify', () => {
    const kc = makeKc([{ name: 'c1', server: 'https://10.0.0.1:6443', caData: 'dGVzdC1jYQ==', skipTLSVerify: true }]);
    applyTlsFallback(kc);
    expect(kc.clusters[0].skipTLSVerify).toBe(true);
  });

  it('handles multiple clusters independently', () => {
    const kc = makeKc([
      { name: 'no-ca', server: 'https://10.0.0.1:6443' },
      { name: 'with-ca', server: 'https://10.0.0.2:6443', caData: 'dGVzdC1jYQ==' },
    ]);
    applyTlsFallback(kc);
    expect(kc.clusters[0].skipTLSVerify).toBe(true);
    expect(kc.clusters[1].skipTLSVerify).toBeFalsy();
  });
});
