import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '@/lib/supabase';

type Step = 'email' | 'code';

export default function SignIn() {
  const [step, setStep] = useState<Step>('email');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      setError('Enter your name.');
      return;
    }
    if (!trimmedEmail) {
      setError('Enter your email address.');
      return;
    }
    setLoading(true);
    setError(null);
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: trimmedEmail,
      options: { shouldCreateUser: true },
    });
    setLoading(false);
    if (otpError) {
      setError(otpError.message);
      return;
    }
    setStep('code');
  }

  async function verifyCode() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter the code from your email.');
      return;
    }
    setLoading(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: trimmed,
      type: 'email',
    });
    if (verifyError) {
      setLoading(false);
      setError(verifyError.message);
      return;
    }

    // Verifying only creates the auth.users row -- our own `person` row
    // (which trip/expense/etc. foreign keys point at) doesn't exist until
    // this RPC runs. Must happen before the person can create/join a trip.
    const { error: personError } = await supabase.rpc('upsert_person', {
      p_name: name.trim(),
    });
    setLoading(false);
    if (personError) {
      setError(personError.message);
      return;
    }
    // No manual navigation here: AuthProvider's onAuthStateChange picks up
    // the new session and the root layout's Stack.Protected guard switches
    // to the (tabs) stack automatically.
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>TabMate</Text>

      {step === 'email' ? (
        <View>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            autoCapitalize="words"
            autoCorrect={false}
            editable={!loading}
          />
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={!loading}
            onSubmitEditing={sendCode}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable style={styles.button} onPress={sendCode} disabled={loading}>
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Send code</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View>
          <Text style={styles.label}>Enter the code sent to {email}</Text>
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="123456"
            keyboardType="number-pad"
            autoFocus
            editable={!loading}
            onSubmitEditing={verifyCode}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable style={styles.button} onPress={verifyCode} disabled={loading}>
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Verify</Text>
            )}
          </Pressable>
          <Pressable
            onPress={() => {
              setStep('email');
              setCode('');
              setError(null);
            }}
            disabled={loading}
          >
            <Text style={styles.link}>Use a different email</Text>
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 32, textAlign: 'center' },
  label: { fontSize: 14, marginBottom: 8, color: '#444' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#2f6fed',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#d33', marginBottom: 12 },
  link: { textAlign: 'center', marginTop: 16, color: '#2f6fed' },
});
