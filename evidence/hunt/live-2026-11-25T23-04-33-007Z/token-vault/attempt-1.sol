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
        try IVault(vault).deposit(1 ether) {} catch {}
    }
}
