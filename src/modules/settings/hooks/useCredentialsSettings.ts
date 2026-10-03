import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { ApiKeyItem, CreatedApiKey, GithubCredentialItem } from '@/shared/types';
import { copyTextToClipboard } from '@/shared/utils';

type ApiKeysResponse = {
  apiKeys?: ApiKeyItem[];
  success?: boolean;
  // A plain message from older routes, or the AppError body ({ code, message }).
  error?: string | { message?: string };
  apiKey?: CreatedApiKey;
};

type GithubCredentialsResponse = {
  credentials?: GithubCredentialItem[];
  success?: boolean;
  error?: string;
};

type UseCredentialsSettingsArgs = {
  confirmDeleteApiKeyText: string;
  confirmDeleteGithubCredentialText: string;
};

const getApiError = (payload: { error?: string | { message?: string } } | undefined, fallback: string) => (
  (typeof payload?.error === 'string' ? payload.error : payload?.error?.message) || fallback
);

export function useCredentialsSettings({
  confirmDeleteApiKeyText,
  confirmDeleteGithubCredentialText,
}: UseCredentialsSettingsArgs) {
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [githubCredentials, setGithubCredentials] = useState<GithubCredentialItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNewKeyForm, setShowNewKeyForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  // The Studio password the server asks for before it creates a key; cleared after every attempt.
  const [newKeyPassword, setNewKeyPassword] = useState('');
  // The key whose re-activation waits for the password, and that password; null when none is open.
  const [activatingKeyId, setActivatingKeyId] = useState<string | null>(null);
  const [activationPassword, setActivationPassword] = useState('');
  // The server's answer to the last create or re-activation (wrong password, too many attempts).
  const [apiKeyError, setApiKeyError] = useState('');

  const [showNewGithubForm, setShowNewGithubForm] = useState(false);
  const [newGithubName, setNewGithubName] = useState('');
  const [newGithubToken, setNewGithubToken] = useState('');
  const [newGithubDescription, setNewGithubDescription] = useState('');

  const [showToken, setShowToken] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<CreatedApiKey | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);

      const [apiKeysResponse, credentialsResponse] = await Promise.all([
        api.settings.apiKeys(),
        api.settings.credentials('github_token'),
      ]);

      const [apiKeysPayload, credentialsPayload] = await Promise.all([
        apiKeysResponse.json() as Promise<ApiKeysResponse>,
        credentialsResponse.json() as Promise<GithubCredentialsResponse>,
      ]);

      setApiKeys(apiKeysPayload.apiKeys || []);
      setGithubCredentials(credentialsPayload.credentials || []);
    } catch (error) {
      console.error('Error fetching settings:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const createApiKey = useCallback(async () => {
    if (!newKeyName.trim() || !newKeyPassword) {
      return;
    }

    setApiKeyError('');
    try {
      const response = await api.settings.createApiKey(newKeyName.trim(), newKeyPassword);
      setNewKeyPassword('');

      const payload = await response.json() as ApiKeysResponse;
      if (!response.ok || !payload.success) {
        setApiKeyError(getApiError(payload, 'Failed to create API key'));
        return;
      }

      if (payload.apiKey) {
        setNewlyCreatedKey(payload.apiKey);
      }
      setNewKeyName('');
      setShowNewKeyForm(false);
      await fetchData();
    } catch (error) {
      console.error('Error creating API key:', error);
    }
  }, [fetchData, newKeyName, newKeyPassword]);

  const deleteApiKey = useCallback(async (keyId: string) => {
    if (!window.confirm(confirmDeleteApiKeyText)) {
      return;
    }

    try {
      const response = await api.settings.deleteApiKey(keyId);

      if (!response.ok) {
        const payload = await response.json() as ApiKeysResponse;
        console.error('Error deleting API key:', getApiError(payload, 'Failed to delete API key'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error deleting API key:', error);
    }
  }, [confirmDeleteApiKeyText, fetchData]);

  const toggleApiKey = useCallback(async (keyId: string, isActive: boolean) => {
    // Turning a key back on needs the password: open the field instead of asking the server.
    if (!isActive) {
      setApiKeyError('');
      setActivationPassword('');
      setActivatingKeyId(keyId);
      return;
    }

    try {
      const response = await api.settings.toggleApiKey(keyId, false);

      if (!response.ok) {
        const payload = await response.json() as ApiKeysResponse;
        console.error('Error toggling API key:', getApiError(payload, 'Failed to toggle API key'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error toggling API key:', error);
    }
  }, [fetchData]);

  const confirmActivation = useCallback(async () => {
    if (!activatingKeyId || !activationPassword) {
      return;
    }

    setApiKeyError('');
    try {
      const response = await api.settings.toggleApiKey(activatingKeyId, true, activationPassword);
      setActivationPassword('');

      if (!response.ok) {
        const payload = await response.json() as ApiKeysResponse;
        setApiKeyError(getApiError(payload, 'Failed to turn the API key on'));
        return;
      }

      setActivatingKeyId(null);
      await fetchData();
    } catch (error) {
      console.error('Error toggling API key:', error);
    }
  }, [activatingKeyId, activationPassword, fetchData]);

  const cancelActivation = useCallback(() => {
    setActivatingKeyId(null);
    setActivationPassword('');
    setApiKeyError('');
  }, []);

  const createGithubCredential = useCallback(async () => {
    if (!newGithubName.trim() || !newGithubToken.trim()) {
      return;
    }

    try {
      const response = await api.settings.createCredential({
        credentialName: newGithubName.trim(),
        credentialType: 'github_token',
        credentialValue: newGithubToken,
        description: newGithubDescription.trim(),
      });

      const payload = await response.json() as GithubCredentialsResponse;
      if (!response.ok || !payload.success) {
        console.error('Error creating GitHub credential:', getApiError(payload, 'Failed to create GitHub credential'));
        return;
      }

      setNewGithubName('');
      setNewGithubToken('');
      setNewGithubDescription('');
      setShowNewGithubForm(false);
      setShowToken((prev) => ({ ...prev, new: false }));
      await fetchData();
    } catch (error) {
      console.error('Error creating GitHub credential:', error);
    }
  }, [fetchData, newGithubDescription, newGithubName, newGithubToken]);

  const deleteGithubCredential = useCallback(async (credentialId: string) => {
    if (!window.confirm(confirmDeleteGithubCredentialText)) {
      return;
    }

    try {
      const response = await api.settings.deleteCredential(credentialId);

      if (!response.ok) {
        const payload = await response.json() as GithubCredentialsResponse;
        console.error('Error deleting GitHub credential:', getApiError(payload, 'Failed to delete GitHub credential'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error deleting GitHub credential:', error);
    }
  }, [confirmDeleteGithubCredentialText, fetchData]);

  const toggleGithubCredential = useCallback(async (credentialId: string, isActive: boolean) => {
    try {
      const response = await api.settings.toggleCredential(credentialId, !isActive);

      if (!response.ok) {
        const payload = await response.json() as GithubCredentialsResponse;
        console.error('Error toggling GitHub credential:', getApiError(payload, 'Failed to toggle GitHub credential'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error toggling GitHub credential:', error);
    }
  }, [fetchData]);

  const copyToClipboard = useCallback(async (text: string, id: string) => {
    try {
      await copyTextToClipboard(text);
      setCopiedKey(id);
      window.setTimeout(() => setCopiedKey(null), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  }, []);

  const dismissNewlyCreatedKey = useCallback(() => {
    setNewlyCreatedKey(null);
  }, []);

  const cancelNewApiKeyForm = useCallback(() => {
    setShowNewKeyForm(false);
    setNewKeyName('');
    setNewKeyPassword('');
    setApiKeyError('');
  }, []);

  const cancelNewGithubForm = useCallback(() => {
    setShowNewGithubForm(false);
    setNewGithubName('');
    setNewGithubToken('');
    setNewGithubDescription('');
    setShowToken((prev) => ({ ...prev, new: false }));
  }, []);

  const toggleNewGithubTokenVisibility = useCallback(() => {
    setShowToken((prev) => ({ ...prev, new: !prev.new }));
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    apiKeys,
    githubCredentials,
    loading,
    showNewKeyForm,
    setShowNewKeyForm,
    newKeyName,
    setNewKeyName,
    newKeyPassword,
    setNewKeyPassword,
    activatingKeyId,
    activationPassword,
    setActivationPassword,
    confirmActivation,
    cancelActivation,
    apiKeyError,
    showNewGithubForm,
    setShowNewGithubForm,
    newGithubName,
    setNewGithubName,
    newGithubToken,
    setNewGithubToken,
    newGithubDescription,
    setNewGithubDescription,
    showToken,
    copiedKey,
    newlyCreatedKey,
    createApiKey,
    deleteApiKey,
    toggleApiKey,
    createGithubCredential,
    deleteGithubCredential,
    toggleGithubCredential,
    copyToClipboard,
    dismissNewlyCreatedKey,
    cancelNewApiKeyForm,
    cancelNewGithubForm,
    toggleNewGithubTokenVisibility,
  };
}
