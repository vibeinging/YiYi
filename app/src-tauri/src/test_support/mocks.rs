//! Mockall-generated mocks for external traits we can't modify directly.

use memme_llm::{GenerateOptions, LlmError, LlmProvider, Message};

mockall::mock! {
    pub LlmProviderImpl {}

    impl LlmProvider for LlmProviderImpl {
        fn generate<'a>(&self, messages: &'a [Message], options: &'a GenerateOptions) -> Result<String, LlmError>;
        fn name(&self) -> &'static str;
    }
}

pub type MockLlmProvider = MockLlmProviderImpl;

#[cfg(test)]
mod tests {
    use super::*;
    use memme_llm::MessageRole;
    use mockall::predicate::*;

    #[test]
    fn mock_llm_returns_configured_response() {
        let mut mock = MockLlmProvider::new();
        mock.expect_generate()
            .with(always(), always())
            .returning(|_msgs, _opts| Ok("mocked response".to_string()));
        mock.expect_name().return_const("mock");

        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".to_string(),
        }];
        let opts = GenerateOptions {
            temperature: None,
            max_tokens: None,
            response_format: None,
        };
        let out = mock.generate(&msgs, &opts).unwrap();
        assert_eq!(out, "mocked response");
        assert_eq!(mock.name(), "mock");
    }

    #[test]
    fn mock_llm_can_return_error() {
        let mut mock = MockLlmProvider::new();
        mock.expect_generate()
            .returning(|_, _| Err(LlmError::NotAvailable("simulated failure".to_string())));

        let opts = GenerateOptions {
            temperature: None,
            max_tokens: None,
            response_format: None,
        };
        let err = mock.generate(&[], &opts).unwrap_err();
        assert!(format!("{:?}", err).contains("simulated failure"));
    }
}
