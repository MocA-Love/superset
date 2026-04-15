{
	"targets": [
		{
			"target_name": "macos_window_blur",
			"sources": ["src/addon.mm"],
			"include_dirs": [
				"<!@(node -p \"require('node-addon-api').include\")"
			],
			"defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
			"conditions": [
				["OS=='mac'", {
					"xcode_settings": {
						"MACOSX_DEPLOYMENT_TARGET": "11.0",
						"CLANG_CXX_LANGUAGE_STANDARD": "c++17",
						"OTHER_CFLAGS": ["-fobjc-arc"]
					},
					"link_settings": {
						"libraries": [
							"-framework Cocoa",
							"-framework QuartzCore",
							"-framework CoreImage"
						]
					}
				}]
			]
		}
	]
}
