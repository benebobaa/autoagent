#!/bin/sh
# Patches @mrgnlabs/marginfi-client-v2 to use IDL 0.1.8
# This fixes the Borsh decode error caused by new account types (Order, ExecuteOrderRecord, Lending)
# that were added in the mrgn-0.1.8-rc3 on-chain program update

set -e

IDL_SOURCE="${1:-./idl-patches/marginfi_0.1.8.json}"
SDK_PATH="./node_modules/@mrgnlabs/marginfi-client-v2/dist/idl"

echo "Patching marginfi-client-v2 IDL..."
echo "  Source: $IDL_SOURCE"
echo "  Target: $SDK_PATH"

if [ ! -f "$IDL_SOURCE" ]; then
    echo "ERROR: IDL source file not found: $IDL_SOURCE"
    exit 1
fi

if [ ! -d "$SDK_PATH" ]; then
    echo "ERROR: marginfi-client-v2 not found in node_modules"
    exit 1
fi

# Copy the new IDL
cp "$IDL_SOURCE" "$SDK_PATH/marginfi_0.1.8.json"
echo "  Copied marginfi_0.1.8.json"

# Patch index.js to use the new IDL
cat > "$SDK_PATH/index.js" << 'EOF'
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARGINFI_IDL = void 0;
const marginfi_0_1_8_json_1 = __importDefault(require("./marginfi_0.1.8.json"));
exports.MARGINFI_IDL = marginfi_0_1_8_json_1.default;
EOF
echo "  Patched index.js to use marginfi_0.1.8.json"

echo "Patch complete!"
