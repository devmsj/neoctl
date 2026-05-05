export interface CredentialProvider {
  getCredential(): Promise<string | undefined>;
}

export class StaticCredentialProvider implements CredentialProvider {
  constructor(private readonly credential?: string) {}

  async getCredential(): Promise<string | undefined> {
    return this.credential;
  }
}

export class EnvCredentialProvider implements CredentialProvider {
  constructor(private readonly envName = "OPENAI_API_KEY") {}

  async getCredential(): Promise<string | undefined> {
    return process.env[this.envName];
  }
}
